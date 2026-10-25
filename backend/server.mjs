import http from 'node:http'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const { Pool } = pg

const port = Number(process.env.PORT || 3000)
const universityScheduleUrl = process.env.UNIVERSITY_SCHEDULE_URL || ''
const users = new Map()
const sessions = new Map()
const queueEntries = new Map()
const labProgress = new Set()
// Режим выбирается на старте: с доступной БД — PostgreSQL, без неё — in-memory
// для разработки. Если БД задана, но недоступна (например, бесплатный тариф
// кончился), сервер не падает, а громко уходит в память до рестарта.
let pool = null
if (process.env.DATABASE_URL) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 })
}

class ApiError extends Error {
  constructor(status, message, code = 'API_ERROR') {
    super(message)
    this.status = status
    this.code = code
  }
}

async function initDatabase() {
  if (!pool) return
  try {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      telegram_id TEXT UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      group_number TEXT NOT NULL,
      subgroup INTEGER NOT NULL DEFAULT 1,
      notifications BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS subgroup INTEGER NOT NULL DEFAULT 1;
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS queue_entries (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lesson_id TEXT NOT NULL,
      lab_no INTEGER,
      status TEXT NOT NULL DEFAULT 'waiting',
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Место в очереди не хранится: оно вычисляется сортировкой
    -- (класс приоритета, joined_at). Номер «текущей» лабы считает expectedLabNo.
    ALTER TABLE queue_entries DROP CONSTRAINT IF EXISTS queue_entries_user_id_key;
    ALTER TABLE queue_entries DROP CONSTRAINT IF EXISTS queue_entries_lesson_id_number_key;
    ALTER TABLE queue_entries DROP COLUMN IF EXISTS number;
    ALTER TABLE queue_entries ADD COLUMN IF NOT EXISTS lab_no INTEGER;
    -- Активное место в очереди только одно; завершённые записи остаются
    -- до конца пары как «сдавшие».
    CREATE UNIQUE INDEX IF NOT EXISTS queue_entries_user_waiting_uidx
      ON queue_entries (user_id) WHERE status = 'waiting';
    CREATE INDEX IF NOT EXISTS queue_entries_lesson_idx ON queue_entries (lesson_id);
    CREATE TABLE IF NOT EXISTS lab_progress (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lab_no INTEGER NOT NULL,
      passed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, lab_no)
    );
    DELETE FROM users u USING users v
      WHERE u.group_number = v.group_number AND u.name = v.name AND u.id > v.id;
    CREATE UNIQUE INDEX IF NOT EXISTS users_group_name_uidx ON users (group_number, name);
    `)
    console.log('Database: PostgreSQL connected')
  } catch (err) {
    pool = null
    console.error('Database unavailable — in-memory mode (queue and sessions reset on restart):', err instanceof Error ? err.message : err)
  }
}

// TTL-кэш расписания по группе: очередь опрашивается каждые несколько секунд,
// и без кэша каждый запрос ходил бы в университетский API.
const SCHEDULE_CACHE_TTL_MS = 5 * 60 * 1000
const scheduleCache = new Map()

function extractSubgroup(item) {
  if (!item || typeof item !== 'object') return 0
  const raw = Number(item.numSubgroup ?? item.subgroup ?? item.subGroup ?? 0)
  if (raw === 1 || raw === 2) return raw
  const text = `${item.note || ''} ${item.title || ''}`
  if (/(?:^|\s|[,;(])1(?:\s*-?я)?\s*(?:подгрупп|п\/г|пг)/i.test(text) || /(?:подгрупп[аы]?|п\/г)\s*№?\s*1\b/i.test(text)) return 1
  if (/(?:^|\s|[,;(])2(?:\s*-?я)?\s*(?:подгрупп|п\/г|пг)/i.test(text) || /(?:подгрупп[аы]?|п\/г)\s*№?\s*2\b/i.test(text)) return 2
  return 0
}

function normalizeLessons(payload) {
  const candidate = Array.isArray(payload) ? payload : payload?.lessons || payload?.schedule || payload?.schedules || payload?.data || payload?.items || payload
  const isDate = value => typeof value === 'string' && (/^\d{4}-\d{2}-\d{2}/.test(value) || /^\d{2}\.\d{2}\.\d{4}$/.test(value))
  const source = Array.isArray(candidate)
    ? candidate.map(item => ({ item }))
    : candidate && (candidate.subject || candidate.subjectFullName || candidate.startLessonTime)
      ? [{ item: candidate }]
      : candidate && typeof candidate === 'object'
        ? Object.entries(candidate).flatMap(([key, value]) => Array.isArray(value) ? value.map(item => ({ item, outerDate: isDate(key) ? key : '' })) : [])
        : []
  const toStandardDate = val => {
    const d = parseDate(val)
    return d ? formatYMD(d) : String(val || '')
  }

  const mapped = source.map(({ item, outerDate }, index) => {
    const rawDate = String(item.date || (isDate(item.dateLesson) ? item.dateLesson : '') || outerDate || (isDate(item.startLessonDate) ? item.startLessonDate : ''))
    const date = toStandardDate(rawDate) || rawDate
    return {
      id: String(item.id || item.lessonId || item.universityId || `university-lesson-${index + 1}`),
      subject: String(item.subject || item.subjectName || item.subjectFullName || 'Занятие'),
      subjectId: String(item.subjectId || item.subjectCode || (item.subject || item.subjectName || 'lab').toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-')),
      title: String(item.title || item.name || item.subjectFullName || item.subject || `Занятие №${index + 1}`),
      date,
      startTime: String(item.startTime || item.start || item.startLessonTime || item.timeFrom || ''),
      endTime: String(item.endTime || item.end || item.endLessonTime || item.timeTo || ''),
      teacher: item.teacher || item.instructor || (Array.isArray(item.employees) && item.employees[0] ? [item.employees[0].lastName, item.employees[0].firstName, item.employees[0].middleName].filter(Boolean).join(' ') : undefined),
      room: item.room || item.classroom || (Array.isArray(item.auditories) ? item.auditories[0] : undefined),
      note: item.note || undefined,
      lessonTypeAbbrev: item.lessonTypeAbbrev || undefined,
      subgroup: extractSubgroup(item),
      registrationStatus: item.registrationStatus || item.registration || 'open',
      registration: item.registration || item.registrationStatus || 'open'
    }
  }).filter(item => item.date && item.startTime)

  // Sort chronologically by date ascending, then startTime ascending, then subgroup
  return mapped.sort((a, b) => {
    const d = a.date.localeCompare(b.date)
    if (d !== 0) return d
    const t = a.startTime.localeCompare(b.startTime)
    if (t !== 0) return t
    return (a.subgroup || 0) - (b.subgroup || 0)
  })
}

const weekdayNames = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота']
const xmlValue = (block, tag) => block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'))?.[1]?.trim() || ''
const xmlValues = (block, tag) => [...block.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'gi'))].map(match => match[1].trim()).filter(Boolean)
const parseDate = value => {
  const text = String(value || '').trim()
  const ru = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/)
  if (ru) return new Date(Number(ru[3]), Number(ru[2]) - 1, Number(ru[1]), 12, 0, 0)
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12, 0, 0)
  return null
}
const formatYMD = date => {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function getMinskDate() {
  const now = new Date()
  const utc = now.getTime() + now.getTimezoneOffset() * 60000
  return new Date(utc + 3 * 3600000)
}

function isLessonEnded(lesson) {
  if (!lesson || !lesson.date) return false
  const minskNow = getMinskDate()
  const todayYMD = formatYMD(minskNow)

  if (lesson.date < todayYMD) return true
  if (lesson.date > todayYMD) return false

  if (!lesson.endTime) return false
  const [endH, endM] = lesson.endTime.split(':').map(Number)
  if (isNaN(endH) || isNaN(endM)) return false

  const currentTotal = minskNow.getHours() * 60 + minskNow.getMinutes()
  const endTotal = endH * 60 + endM

  return currentTotal >= endTotal
}

// Каденция курса: одна лаба на подгруппу раз в две недели (две лабы в месяц).
const WEEKS_PER_LAB = 2

function mondayOf(date) {
  const monday = new Date(date)
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7)
  monday.setHours(12, 0, 0, 0)
  return monday
}

// Номер недели семестра от его начала (оценка: осень — с 1 сентября, весна — с 7 февраля).
function getSemesterWeek(date) {
  const year = date.getFullYear()
  const termStart = date.getMonth() >= 7 ? new Date(year, 8, 1, 12, 0, 0) : new Date(year, 1, 7, 12, 0, 0)
  const weeks = Math.floor((mondayOf(date).getTime() - mondayOf(termStart).getTime()) / (7 * 86400000)) + 1
  return weeks
}

// Какая лаба «по плану» на этом занятии.
function expectedLabNo(lesson) {
  const d = parseDate(lesson?.date)
  if (!d) return null
  return Math.max(1, Math.ceil(getSemesterWeek(d) / WEEKS_PER_LAB))
}

// Приоритет: 1 — долг, 2 — текущая, 3 — впереди программы.
function priorityClassFor(labNo, currentLabNo) {
  if (!labNo || !currentLabNo) return 2
  if (labNo < currentLabNo) return 1
  if (labNo === currentLabNo) return 2
  return 3
}

function getWeekNumber(date, termStart, currentWeek, todayDate) {
  if (currentWeek && todayDate) {
    const dayOfWeekToday = (todayDate.getDay() + 6) % 7
    const mondayToday = new Date(todayDate)
    mondayToday.setDate(mondayToday.getDate() - dayOfWeekToday)
    mondayToday.setHours(12, 0, 0, 0)

    const dayOfWeekTarget = (date.getDay() + 6) % 7
    const mondayTarget = new Date(date)
    mondayTarget.setDate(mondayTarget.getDate() - dayOfWeekTarget)
    mondayTarget.setHours(12, 0, 0, 0)

    const diffWeeks = Math.round((mondayTarget.getTime() - mondayToday.getTime()) / (7 * 86400000))
    return ((((currentWeek - 1 + diffWeeks) % 4) + 4) % 4) + 1
  }

  if (termStart) {
    const dayOfWeekTerm = (termStart.getDay() + 6) % 7
    const mondayTerm = new Date(termStart)
    mondayTerm.setDate(mondayTerm.getDate() - dayOfWeekTerm)
    mondayTerm.setHours(12, 0, 0, 0)

    const dayOfWeekTarget = (date.getDay() + 6) % 7
    const mondayTarget = new Date(date)
    mondayTarget.setDate(mondayTarget.getDate() - dayOfWeekTarget)
    mondayTarget.setHours(12, 0, 0, 0)

    const diffWeeks = Math.floor((mondayTarget.getTime() - mondayTerm.getTime()) / (7 * 86400000))
    return (((diffWeeks % 4) + 4) % 4) + 1
  }

  const year = date.getFullYear()
  const month = date.getMonth()
  const termStartEstimated = month >= 7 ? new Date(year, 8, 1, 12, 0, 0) : new Date(year, 1, 7, 12, 0, 0)
  const dayOfWeekEst = (termStartEstimated.getDay() + 6) % 7
  const mondayEst = new Date(termStartEstimated)
  mondayEst.setDate(mondayEst.getDate() - dayOfWeekEst)
  mondayEst.setHours(12, 0, 0, 0)

  const dayOfWeekTarget = (date.getDay() + 6) % 7
  const mondayTarget = new Date(date)
  mondayTarget.setDate(mondayTarget.getDate() - dayOfWeekTarget)
  mondayTarget.setHours(12, 0, 0, 0)

  const diffWeeks = Math.floor((mondayTarget.getTime() - mondayEst.getTime()) / (7 * 86400000))
  return (((diffWeeks % 4) + 4) % 4) + 1
}

function expandWeeklyEntries(entries, weekday, termStart, termEnd, currentWeek, todayDate) {
  if (!Array.isArray(entries)) return []
  const result = []
  entries.forEach((item, index) => {
    const start = parseDate(item.startLessonDate) || termStart
    const end = parseDate(item.endLessonDate) || termEnd
    const oneOffDate = parseDate(item.dateLesson)
    const weeks = (Array.isArray(item.weekNumber) ? item.weekNumber : []).map(Number).filter(Boolean)
    const sub = extractSubgroup(item)
    const add = date => {
      const dStr = formatYMD(date)
      result.push({
        ...item,
        numSubgroup: sub,
        id: `${item.id || item.lessonId || item.subject || 'lesson'}-${dStr}-${item.startLessonTime || item.startTime || ''}-sg${sub}-${index}`,
        date: dStr
      })
    }
    if (oneOffDate) return add(oneOffDate)
    if (!start || !end || !weeks.length) return

    for (let cur = new Date(start); cur <= end; cur.setDate(cur.getDate() + 1)) {
      if (cur.getDay() !== weekday) continue
      const week = getWeekNumber(cur, termStart, currentWeek, todayDate)
      if (weeks.includes(week)) add(new Date(cur))
    }
  })
  return result
}

function expandJsonSchedule(payload) {
  const schedules = payload?.schedules
  if (!schedules || Array.isArray(schedules) || typeof schedules !== 'object') return payload
  const termStart = parseDate(payload.startDate || payload.dateStart)
  const termEnd = parseDate(payload.endDate || payload.dateEnd)
  const currentWeek = Number(payload.currentWeekNumber) || undefined
  const todayDate = parseDate(payload.todayDate)

  const entries = Object.entries(schedules).flatMap(([dayName, lessonsForDay]) => {
    const weekday = weekdayNames.indexOf(dayName.toLowerCase())
    return weekday > 0 ? expandWeeklyEntries(lessonsForDay, weekday, termStart, termEnd, currentWeek, todayDate) : []
  })
  return entries.length ? entries : payload
}

function expandXmlSchedule(xml) {
  const schedules = xml.match(/<schedules>([\s\S]*?)<\/schedules>/i)?.[1] || ''
  const termStart = parseDate(xmlValue(xml, 'startDate') || xmlValue(xml, 'dateStart'))
  const termEnd = parseDate(xmlValue(xml, 'endDate') || xmlValue(xml, 'dateEnd'))
  const currentWeek = Number(xmlValue(xml, 'currentWeekNumber')) || undefined
  const todayDate = parseDate(xmlValue(xml, 'todayDate'))
  const result = []
  const dayPattern = new RegExp(`<(${weekdayNames.slice(1).join('|')})>([\\s\\S]*?)</\\1>`, 'gi')
  for (const dayMatch of schedules.matchAll(dayPattern)) {
    const weekday = weekdayNames.indexOf(dayMatch[1].toLowerCase())
    const block = dayMatch[2]
    const start = parseDate(xmlValue(block, 'startLessonDate')) || termStart
    const end = parseDate(xmlValue(block, 'endLessonDate')) || termEnd
    const subject = xmlValue(block, 'subject')
    const subjectFullName = xmlValue(block, 'subjectFullName')
    const weekNumbers = xmlValues(block, 'weekNumber').map(Number).filter(Boolean)
    const dateLesson = parseDate(xmlValue(block, 'dateLesson'))
    const numSubgroup = Number(xmlValue(block, 'numSubgroup')) || 0
    const base = {
      subject,
      subjectFullName,
      title: subjectFullName || subject,
      startLessonTime: xmlValue(block, 'startLessonTime'),
      endLessonTime: xmlValue(block, 'endLessonTime'),
      lessonTypeAbbrev: xmlValue(block, 'lessonTypeAbbrev'),
      numSubgroup,
      note: xmlValue(block, 'note'),
      room: xmlValues(block, 'auditories')[0] || ''
    }
    const addLesson = date => {
      const dStr = formatYMD(date)
      result.push({ ...base, date: dStr, id: `${subject}-${dStr}-${base.startLessonTime}-sg${numSubgroup}` })
    }
    if (dateLesson) addLesson(dateLesson)
    else if (start && end && weekNumbers.length) {
      for (let cur = new Date(start); cur <= end; cur.setDate(cur.getDate() + 1)) {
        if (cur.getDay() !== weekday) continue
        const week = getWeekNumber(cur, termStart, currentWeek, todayDate)
        if (weekNumbers.includes(week)) addLesson(new Date(cur))
      }
    }
  }
  return result
}

async function getUniversitySchedule(groupNumber) {
  const cached = scheduleCache.get(groupNumber)
  if (cached && cached.expiresAt > Date.now()) return cached.lessons

  const scheduleBaseUrl = universityScheduleUrl || 'https://iis.bsuir.by/api/v1/schedule?studentGroup={groupNumber}'
  const requestUrl = scheduleBaseUrl.replaceAll('{groupNumber}', encodeURIComponent(groupNumber))
  console.log(`Schedule request: ${requestUrl}`)
  let response
  try {
    response = await fetch(requestUrl, { headers: { Accept: 'application/json, application/xml, text/xml', 'User-Agent': 'LabFlow/1.0' } })
  } catch (error) {
    console.error('Schedule upstream network error:', error instanceof Error ? error.message : error)
    throw new Error('University schedule network error')
  }
  if (!response.ok) {
    const details = await response.text().catch(() => '')
    console.error(`Schedule upstream HTTP ${response.status}:`, details.slice(0, 500))
    throw new Error(`University schedule returned ${response.status}`)
  }
  const raw = await response.text()
  let payload
  try { payload = expandJsonSchedule(JSON.parse(raw)) } catch { payload = expandXmlSchedule(raw) }
  const normalized = normalizeLessons(payload)
  if (!normalized.length) console.warn('Schedule upstream returned no recognizable lessons')
  console.log(`Schedule response: ${normalized.length} lessons`)
  scheduleCache.set(groupNumber, { lessons: normalized, expiresAt: Date.now() + SCHEDULE_CACHE_TTL_MS })
  return normalized
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS' })
  res.end(JSON.stringify(payload))
}

async function body(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new ApiError(400, 'Некорректный JSON в теле запроса.', 'INVALID_JSON')
  }
}

async function userFromRequest(req) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (pool) {
    if (!token) return null
    const result = await pool.query(`SELECT u.id, u.telegram_id AS "telegramId", u.name, u.group_number AS "group", COALESCE(u.subgroup, 1) AS "subgroup", u.notifications FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1`, [token])
    return result.rows[0] || null
  }
  const userId = sessions.get(token)
  return userId ? users.get(userId) : null
}

async function queueForUser(userId, group) {
  let entry = null
  if (pool) {
    const result = await pool.query(`SELECT id, user_id AS "userId", lesson_id AS "lessonId", lab_no AS "labNo", status, joined_at AS "joinedAt" FROM queue_entries WHERE user_id = $1 AND status = 'waiting'`, [userId])
    entry = result.rows[0] || null
  } else {
    entry = [...queueEntries.values()].find(e => e.userId === userId && e.status !== 'completed') || null
  }
  if (!entry) return null

  // If lesson has ended, auto-clean old entry
  if (group) {
    try {
      const schedule = await getUniversitySchedule(group)
      const lesson = schedule.find(l => l.id === entry.lessonId)
      if (lesson && isLessonEnded(lesson)) {
        if (pool) {
          await pool.query(`DELETE FROM queue_entries WHERE id = $1`, [entry.id])
        } else {
          queueEntries.delete(entry.id)
        }
        return null
      }
    } catch {}
  }

  return entry
}

async function deleteQueueEntriesForUser(userId) {
  if (pool) {
    await pool.query(`DELETE FROM queue_entries WHERE user_id = $1 AND status = 'waiting'`, [userId])
    return
  }
  for (const [id, entry] of queueEntries.entries()) {
    if (entry.userId === userId && entry.status !== 'completed') queueEntries.delete(id)
  }
}

async function deleteQueueEntriesForLesson(lessonIds) {
  if (pool) {
    await pool.query(`DELETE FROM queue_entries WHERE lesson_id = ANY($1)`, [lessonIds])
    return
  }
  for (const [id, entry] of queueEntries.entries()) {
    if (lessonIds.includes(entry.lessonId)) queueEntries.delete(id)
  }
}

// Полное состояние очереди занятия: активные (отсортированы по приоритету,
// внутри класса — по времени входа, с вычисленными местами) и сдавшие.
async function getLessonQueue(lessonIds, currentLabNo) {
  let rows = []
  if (pool) {
    const result = await pool.query(`
      SELECT q.id, q.user_id AS "userId", u.name, u.group_number AS "group", q.lab_no AS "labNo", q.status, q.joined_at AS "joinedAt"
      FROM queue_entries q
      JOIN users u ON u.id = q.user_id
      WHERE q.lesson_id = ANY($1)
      ORDER BY q.joined_at ASC
    `, [lessonIds])
    rows = result.rows
  } else {
    rows = [...queueEntries.values()]
      .filter(item => lessonIds.includes(item.lessonId))
      .map(entry => {
        const u = users.get(entry.userId)
        return {
          id: entry.id,
          userId: entry.userId,
          name: u?.name || 'Студент',
          group: u?.group || '',
          labNo: entry.labNo,
          status: entry.status,
          joinedAt: entry.joinedAt
        }
      })
  }

  const formatTime = r => ({
    ...r,
    joinedAt: new Date(r.joinedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Minsk' })
  })

  const activeMembers = rows
    .filter(r => r.status !== 'completed')
    .map(r => ({ ...r, priorityClass: priorityClassFor(r.labNo ?? null, currentLabNo) }))
    .sort((a, b) =>
      a.priorityClass - b.priorityClass ||
      new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime()
    )
    .map((r, i) => formatTime({ ...r, position: i + 1 }))

  const completedMembers = rows.filter(r => r.status === 'completed').map(formatTime)
  return { activeMembers, completedMembers }
}

// Ответ «моя очередь» для /me/queue и join: обогащаем свою запись видом очереди.
async function buildUserQueue(user, entry) {
  let currentLabNo = null
  try {
    const schedule = await getUniversitySchedule(user.group)
    const lesson = schedule.find(l => l.id === entry.lessonId)
    if (lesson) currentLabNo = expectedLabNo(lesson)
  } catch {}

  const { activeMembers, completedMembers } = await getLessonQueue([entry.lessonId], currentLabNo)
  const mine = activeMembers.find(m => m.userId === user.id)
  return {
    id: entry.id,
    lessonId: entry.lessonId,
    labNo: mine?.labNo ?? entry.labNo ?? null,
    priorityClass: mine?.priorityClass ?? null,
    position: mine?.position ?? null,
    peopleAhead: mine ? mine.position - 1 : 0,
    estimatedWaitMinutes: mine ? (mine.position - 1) * 5 : 0,
    status: mine?.status || entry.status,
    joinedAt: mine?.joinedAt || entry.joinedAt,
    members: activeMembers,
    completed: completedMembers,
    currentLabNo
  }
}

export async function handleApiRequest(req, res) {
  if (req.method === 'OPTIONS') {
    json(res, 204, {})
    return true
  }
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const path = url.pathname

    if (req.method === 'GET' && path === '/health') {
      json(res, 200, { ok: true, service: 'labflow-api', db: Boolean(pool) })
      return true
    }

    if (req.method === 'POST' && path === '/auth/login') {
      const { group, name, subgroup } = await body(req)
      const cleanGroup = String(group || '').trim() || '668204'
      const cleanName = String(name || '').trim() || 'Студент'
      const cleanSubgroup = Number(subgroup) === 2 ? 2 : 1
      const token = randomUUID()
      let user
      if (pool) {
        // Один человек (группа + имя) = один пользователь: повторный вход
        // с другого устройства переиспользует аккаунт и место в очереди.
        const result = await pool.query(`
          INSERT INTO users (id, telegram_id, name, group_number, subgroup, notifications)
          VALUES ($1, NULL, $2, $3, $4, TRUE)
          ON CONFLICT (group_number, name) DO UPDATE SET subgroup = EXCLUDED.subgroup
          RETURNING id, telegram_id AS "telegramId", name, group_number AS "group", subgroup, notifications
        `, [randomUUID(), cleanName, cleanGroup, cleanSubgroup])
        user = result.rows[0]
        await pool.query(`INSERT INTO sessions (token, user_id) VALUES ($1, $2)`, [token, user.id])
      } else {
        user = [...users.values()].find(u => u.group === cleanGroup && u.name === cleanName)
        if (user) {
          user.subgroup = cleanSubgroup
        } else {
          user = { id: randomUUID(), telegramId: null, name: cleanName, group: cleanGroup, subgroup: cleanSubgroup, notifications: true }
          users.set(user.id, user)
        }
        sessions.set(token, user.id)
      }
      json(res, 200, { user, token })
      return true
    }

    const user = await userFromRequest(req)
    if (!user) {
      json(res, 401, { code: 'UNAUTHORIZED', message: 'Сессия недействительна.' })
      return true
    }

    if (req.method === 'GET' && path === '/me') {
      json(res, 200, { user })
      return true
    }
    if (req.method === 'PATCH' && path === '/me') {
      const data = await body(req)
      if (typeof data.name === 'string' && data.name.trim()) user.name = data.name.trim()
      if (typeof data.notifications === 'boolean') user.notifications = data.notifications
      if (Number(data.subgroup) === 1 || Number(data.subgroup) === 2) user.subgroup = Number(data.subgroup)
      if (pool) {
        await pool.query(`UPDATE users SET name = $1, notifications = $2, subgroup = $3 WHERE id = $4`, [user.name, user.notifications, user.subgroup || 1, user.id])
      } else {
        users.set(user.id, user)
      }
      json(res, 200, { user })
      return true
    }
    if (req.method === 'GET' && path === '/schedule') {
      const list = await getUniversitySchedule(user.group)
      json(res, 200, { lessons: list })
      return true
    }
    if (req.method === 'GET' && path.match(/^\/lessons\/[^/]+\/queue\/members$/)) {
      const rawId = path.split('/')[2]
      const lessonId = decodeURIComponent(rawId)
      const schedule = await getUniversitySchedule(user.group).catch(() => [])
      const lesson = schedule.find(item => item.id === lessonId || item.id === rawId)

      // Auto-reset queue if lesson is already ended!
      if (lesson && isLessonEnded(lesson)) {
        await deleteQueueEntriesForLesson([lessonId, rawId])
        json(res, 200, { members: [], completed: [], currentLabNo: null, ended: true })
        return true
      }

      const currentLabNo = lesson ? expectedLabNo(lesson) : null
      const { activeMembers, completedMembers } = await getLessonQueue([lessonId, rawId], currentLabNo)
      json(res, 200, { members: activeMembers, completed: completedMembers, currentLabNo })
      return true
    }
    if (req.method === 'GET' && path.startsWith('/lessons/')) {
      const rawId = path.split('/')[2]
      const lessonId = decodeURIComponent(rawId)
      const lesson = (await getUniversitySchedule(user.group)).find(item => item.id === lessonId || item.id === rawId)
      if (lesson) json(res, 200, { lesson })
      else json(res, 404, { message: 'Лабораторная не найдена.' })
      return true
    }
    if (req.method === 'GET' && path === '/me/queue') {
      const entry = await queueForUser(user.id, user.group)
      json(res, 200, { queue: entry ? await buildUserQueue(user, entry) : null })
      return true
    }
    if (req.method === 'POST' && path.match(/^\/lessons\/[^/]+\/queue\/join$/)) {
      const rawId = path.split('/')[2]
      const lessonId = decodeURIComponent(rawId)
      const schedule = await getUniversitySchedule(user.group)
      const lesson = schedule.find(item => item.id === lessonId || item.id === rawId)
      if (!lesson) {
        json(res, 404, { message: 'Занятие не найдено.' })
        return true
      }
      if (isLessonEnded(lesson)) {
        json(res, 400, { message: 'Эта пара уже завершилась. Запись закрыта.' })
        return true
      }
      if (lesson.registrationStatus === 'closed' || lesson.registrationStatus === 'completed') {
        json(res, 409, { message: 'Регистрация закрыта.' })
        return true
      }

      // Какую лабу защищает студент; без выбора — текущая по плану.
      const { labNo } = await body(req)
      const picked = Math.round(Number(labNo))
      const finalLabNo = picked >= 1 && picked <= 12 ? picked : (expectedLabNo(lesson) || 1)

      const existingQueue = await queueForUser(user.id, user.group)
      if (existingQueue) {
        if (existingQueue.lessonId === lessonId || existingQueue.lessonId === rawId) {
          json(res, 200, { queue: await buildUserQueue(user, existingQueue) })
          return true
        }
        // If from another lesson, remove old entry
        if (pool) {
          await pool.query(`DELETE FROM queue_entries WHERE id = $1`, [existingQueue.id])
        } else {
          queueEntries.delete(existingQueue.id)
        }
      }

      const entry = { id: randomUUID(), userId: user.id, lessonId, labNo: finalLabNo, status: 'waiting', joinedAt: new Date().toISOString() }
      if (pool) {
        try {
          await pool.query(
            `INSERT INTO queue_entries (id, user_id, lesson_id, lab_no, status) VALUES ($1, $2, $3, $4, 'waiting')`,
            [entry.id, user.id, lessonId, finalLabNo]
          )
        } catch (err) {
          if (err.code === '23505') {
            throw new ApiError(409, 'Вы уже стоите в очереди.', 'ALREADY_IN_QUEUE')
          }
          throw err
        }
      } else {
        queueEntries.set(entry.id, entry)
      }
      json(res, 201, { queue: await buildUserQueue(user, entry) })
      return true
    }
    // Самоотчёт: студент отмечает свою защиту
    if (req.method === 'POST' && path === '/me/queue/complete') {
      const entry = await queueForUser(user.id, user.group)
      if (!entry) {
        throw new ApiError(404, 'Вы не в очереди.', 'NOT_IN_QUEUE')
      }
      if (pool) {
        const updated = await pool.query(`UPDATE queue_entries SET status = 'completed' WHERE id = $1 AND status = 'waiting' RETURNING id`, [entry.id])
        if (updated.rowCount === 0) {
          throw new ApiError(409, 'Защита уже отмечена.', 'ALREADY_COMPLETED')
        }
        if (entry.labNo) {
          await pool.query(`INSERT INTO lab_progress (user_id, lab_no) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [user.id, entry.labNo])
        }
      } else {
        entry.status = 'completed'
        if (entry.labNo) labProgress.add(`${user.id}:${entry.labNo}`)
      }
      json(res, 200, { ok: true, queue: null })
      return true
    }
    if ((req.method === 'DELETE' || req.method === 'POST') && (path === '/me/queue' || path === '/me/queue/leave')) {
      await deleteQueueEntriesForUser(user.id)
      json(res, 200, { ok: true, queue: null })
      return true
    }

    if (req.method === 'GET' && path === '/me/history') {
      json(res, 200, { history: [] })
      return true
    }
    return false
  } catch (error) {
    if (error instanceof ApiError) {
      json(res, error.status, { code: error.code, message: error.message })
      return true
    }
    console.error(error)
    json(res, 500, { message: 'Внутренняя ошибка сервера.' })
    return true
  }
}

export { initDatabase }

const server = http.createServer(async (req, res) => {
  const handled = await handleApiRequest(req, res)
  if (!handled) {
    json(res, 404, { message: 'Маршрут не найден.' })
  }
})

if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  initDatabase().then(() => server.listen(port, '0.0.0.0', () => console.log(`LabFlow API listening on http://0.0.0.0:${port}`)))
}
