import http from 'node:http'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const { Pool } = pg

const port = Number(process.env.PORT || 3000)
const universityScheduleUrl = process.env.UNIVERSITY_SCHEDULE_URL || ''
const users = new Map()
const sessions = new Map()
const queueEntries = new Map()
let pool = null
try {
  if (process.env.DATABASE_URL) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 })
  }
} catch {
  console.warn('DB not connected — mock active')
  pool = null
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
        notifications BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS queue_entries (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        lesson_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'waiting',
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id),
        UNIQUE (lesson_id, number)
      );
      CREATE INDEX IF NOT EXISTS queue_entries_lesson_idx ON queue_entries (lesson_id, number);
    `)
    console.log('Database: PostgreSQL connected')
  } catch (err) {
    console.warn('DB connection failed — fallback to in-memory active', err)
    pool = null
  }
}

const lessons = [
  {
    id: 'oaip-l3',
    subject: 'ОАиП',
    subjectFullName: 'Основы алгоритмизации и программирования',
    title: 'Лабораторная №3: Двумерные массивы и указатели',
    date: new Date().toISOString().slice(0, 10),
    startTime: '14:30',
    endTime: '16:00',
    teacher: 'Смирнов В.П.',
    room: 'Ауд. 312 (ВЦ)',
    lessonTypeAbbrev: 'Лаб',
    registrationStatus: 'open'
  }
]

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
  return source.map(({ item, outerDate }, index) => ({
    id: String(item.id || item.lessonId || item.universityId || `university-lesson-${index + 1}`),
    subject: String(item.subject || item.subjectName || item.subjectFullName || 'Занятие'),
    subjectId: String(item.subjectId || item.subjectCode || (item.subject || item.subjectName || 'lab').toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-')),
    title: String(item.title || item.name || item.subjectFullName || item.subject || `Занятие №${index + 1}`),
    date: String(item.date || (isDate(item.dateLesson) ? item.dateLesson : '') || outerDate || (isDate(item.startLessonDate) ? item.startLessonDate : 'Дата не указана')),
    startTime: String(item.startTime || item.start || item.startLessonTime || item.timeFrom || ''),
    endTime: String(item.endTime || item.end || item.endLessonTime || item.timeTo || ''),
    teacher: item.teacher || item.instructor || (Array.isArray(item.employees) && item.employees[0] ? [item.employees[0].lastName, item.employees[0].firstName, item.employees[0].middleName].filter(Boolean).join(' ') : undefined),
    room: item.room || item.classroom || (Array.isArray(item.auditories) ? item.auditories[0] : undefined),
    note: item.note || undefined,
    lessonTypeAbbrev: item.lessonTypeAbbrev || undefined,
    registrationStatus: item.registrationStatus || item.registration || 'open',
    registration: item.registration || item.registrationStatus || 'open'
  })).filter(item => item.date && item.startTime)
}

const weekdayNames = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота']
const xmlValue = (block, tag) => block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'))?.[1]?.trim() || ''
const xmlValues = (block, tag) => [...block.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'gi'))].map(match => match[1].trim()).filter(Boolean)
const parseDate = value => { const text = String(value || ''); const ru = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/); const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/); return ru ? new Date(`${ru[3]}-${ru[2]}-${ru[1]}T00:00:00`) : iso ? new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00`) : null }
const isoDate = date => date.toISOString().slice(0, 10)

function expandWeeklyEntries(entries, weekday, termStart) {
  if (!Array.isArray(entries)) return []
  const result = []
  entries.forEach((item, index) => {
    const start = parseDate(item.startLessonDate)
    const end = parseDate(item.endLessonDate)
    const oneOffDate = parseDate(item.dateLesson)
    const weeks = (Array.isArray(item.weekNumber) ? item.weekNumber : []).map(Number).filter(Boolean)
    const add = date => result.push({ ...item, id: `${item.id || item.lessonId || item.subject || 'lesson'}-${isoDate(date)}-${item.startLessonTime || item.startTime || ''}-${index}`, date: isoDate(date) })
    if (oneOffDate) return add(oneOffDate)
    if (!start || !end || !weeks.length) return
    const cycleStart = termStart || start
    for (const date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
      if (date.getDay() !== weekday) continue
      const week = Math.floor((date - cycleStart) / 86400000 / 7) % 4 + 1
      if (weeks.includes(week)) add(new Date(date))
    }
  })
  return result
}

function expandJsonSchedule(payload) {
  const schedules = payload?.schedules
  if (!schedules || Array.isArray(schedules) || typeof schedules !== 'object') return payload
  const termStart = parseDate(payload.startDate)
  const entries = Object.entries(schedules).flatMap(([dayName, lessonsForDay]) => {
    const weekday = weekdayNames.indexOf(dayName.toLowerCase())
    return weekday > 0 ? expandWeeklyEntries(lessonsForDay, weekday, termStart) : []
  })
  return entries.length ? entries : payload
}

function expandXmlSchedule(xml) {
  const schedules = xml.match(/<schedules>([\s\S]*?)<\/schedules>/i)?.[1] || ''
  const termStart = parseDate(xmlValue(xml, 'startDate'))
  const result = []
  const dayPattern = new RegExp(`<(${weekdayNames.slice(1).join('|')})>([\\s\\S]*?)</\\1>`, 'gi')
  for (const dayMatch of schedules.matchAll(dayPattern)) {
    const weekday = weekdayNames.indexOf(dayMatch[1].toLowerCase())
    const block = dayMatch[2]
    const start = parseDate(xmlValue(block, 'startLessonDate'))
    const end = parseDate(xmlValue(block, 'endLessonDate'))
    const subject = xmlValue(block, 'subject')
    const subjectFullName = xmlValue(block, 'subjectFullName')
    const weekNumbers = xmlValues(block, 'weekNumber').map(Number).filter(Boolean)
    const dateLesson = parseDate(xmlValue(block, 'dateLesson'))
    const base = { subject, subjectFullName, title: subjectFullName || subject, startLessonTime: xmlValue(block, 'startLessonTime'), endLessonTime: xmlValue(block, 'endLessonTime'), lessonTypeAbbrev: xmlValue(block, 'lessonTypeAbbrev'), note: xmlValue(block, 'note'), room: xmlValues(block, 'auditories')[0] || '' }
    const addLesson = date => result.push({ ...base, date: isoDate(date), id: `${subject}-${isoDate(date)}-${base.startLessonTime}` })
    if (dateLesson) addLesson(dateLesson)
    else if (start && end && weekNumbers.length) {
      for (const date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
        if (date.getDay() !== weekday) continue
        const cycleStart = termStart || start
        const week = Math.floor((date - cycleStart) / 86400000 / 7) % 4 + 1
        if (weekNumbers.includes(week)) addLesson(new Date(date))
      }
    }
  }
  return result
}

async function getUniversitySchedule(groupNumber) {
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
  return normalized
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS' })
  res.end(JSON.stringify(payload))
}

async function body(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw ? JSON.parse(raw) : {}
}

async function userFromRequest(req) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (pool) {
    if (!token) return null
    const result = await pool.query(`SELECT u.id, u.telegram_id AS "telegramId", u.name, u.group_number AS "group", u.notifications FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1`, [token])
    return result.rows[0] || null
  }
  const userId = sessions.get(token)
  return userId ? users.get(userId) : null
}

async function queueForUser(userId) {
  if (pool) {
    const result = await pool.query(`SELECT id, user_id AS "userId", lesson_id AS "lessonId", number, status, joined_at AS "joinedAt" FROM queue_entries WHERE user_id = $1`, [userId])
    return result.rows[0] || null
  }
  return [...queueEntries.values()].find(entry => entry.userId === userId) || null
}

async function queueResponse(entry) {
  if (!entry) return null
  if (pool) {
    const result = await pool.query(`SELECT COUNT(*)::int AS count FROM queue_entries WHERE lesson_id = $1 AND number < $2 AND status NOT IN ('completed')`, [entry.lessonId, entry.number])
    const peopleAhead = result.rows[0].count
    return { ...entry, peopleAhead, estimatedWaitMinutes: peopleAhead * 5 }
  }
  const sameLesson = [...queueEntries.values()].filter(item => item.lessonId === entry.lessonId).sort((a, b) => a.number - b.number)
  return { ...entry, peopleAhead: sameLesson.filter(item => item.number < entry.number).length, estimatedWaitMinutes: sameLesson.filter(item => item.number < entry.number).length * 5 }
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
      json(res, 200, { ok: true, service: 'labflow-api' })
      return true
    }

    if (req.method === 'POST' && path === '/auth/login') {
      const { group, password, name } = await body(req)
      const cleanGroup = String(group || '').trim() || '668204'
      const cleanName = String(name || '').trim()
      const user = { id: randomUUID(), telegramId: null, name: cleanName, group: cleanGroup, notifications: true }
      const token = randomUUID()
      if (pool) {
        try {
          await pool.query(`INSERT INTO users (id, telegram_id, name, group_number, notifications) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`, [user.id, user.telegramId, user.name, user.group, user.notifications])
          await pool.query(`INSERT INTO sessions (token, user_id) VALUES ($1, $2)`, [token, user.id])
        } catch {
          users.set(user.id, user)
          sessions.set(token, user.id)
        }
      } else {
        users.set(user.id, user)
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
      if (pool) {
        try {
          await pool.query(`UPDATE users SET name = $1, notifications = $2 WHERE id = $3`, [user.name, user.notifications, user.id])
        } catch {
          users.set(user.id, user)
        }
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
      let members = []
      if (pool) {
        try {
          const result = await pool.query(`
            SELECT q.id, q.number, q.status, q.joined_at AS "joinedAt", q.user_id AS "userId", u.name, u.group_number AS "group"
            FROM queue_entries q
            JOIN users u ON u.id = q.user_id
            WHERE q.lesson_id = $1 OR q.lesson_id = $2
            ORDER BY q.number ASC
          `, [lessonId, rawId])
          members = result.rows.map(r => ({
            ...r,
            joinedAt: new Date(r.joinedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
          }))
        } catch {
          const entries = [...queueEntries.values()].filter(item => item.lessonId === lessonId || item.lessonId === rawId).sort((a, b) => a.number - b.number)
          members = entries.map(entry => {
            const u = users.get(entry.userId)
            return {
              id: entry.id,
              number: entry.number,
              userId: entry.userId,
              name: u?.name || 'Студент',
              group: u?.group || user.group,
              status: entry.status,
              joinedAt: new Date(entry.joinedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
            }
          })
        }
      } else {
        const entries = [...queueEntries.values()].filter(item => item.lessonId === lessonId || item.lessonId === rawId).sort((a, b) => a.number - b.number)
        members = entries.map(entry => {
          const u = users.get(entry.userId)
          return {
            id: entry.id,
            number: entry.number,
            userId: entry.userId,
            name: u?.name || 'Студент',
            group: u?.group || user.group,
            status: entry.status,
            joinedAt: new Date(entry.joinedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
          }
        })
      }
      json(res, 200, { members })
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
      json(res, 200, { queue: await queueResponse(await queueForUser(user.id)) })
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
      if (lesson.registrationStatus === 'closed' || lesson.registrationStatus === 'completed') {
        json(res, 409, { message: 'Регистрация закрыта.' })
        return true
      }
      if (await queueForUser(user.id)) {
        json(res, 409, { message: 'Вы уже в очереди.' })
        return true
      }
      let entry
      if (pool) {
        try {
          const result = await pool.query(`INSERT INTO queue_entries (id, user_id, lesson_id, number) SELECT $1, $2, $3, COALESCE(MAX(number), 0) + 1 FROM queue_entries WHERE lesson_id = $3 RETURNING id, user_id AS "userId", lesson_id AS "lessonId", number, status, joined_at AS "joinedAt"`, [randomUUID(), user.id, lessonId])
          entry = result.rows[0]
        } catch {
          const existing = [...queueEntries.values()].filter(item => item.lessonId === lessonId || item.lessonId === rawId)
          entry = { id: randomUUID(), userId: user.id, lessonId, number: existing.length + 1, status: 'waiting', joinedAt: new Date().toISOString() }
          queueEntries.set(entry.id, entry)
        }
      } else {
        const existing = [...queueEntries.values()].filter(item => item.lessonId === lessonId || item.lessonId === rawId)
        entry = { id: randomUUID(), userId: user.id, lessonId, number: existing.length + 1, status: 'waiting', joinedAt: new Date().toISOString() }
        queueEntries.set(entry.id, entry)
      }
      json(res, 201, { queue: await queueResponse(entry) })
      return true
    }
    if (req.method === 'DELETE' && path.match(/^\/queues\/[^/]+\/leave$/)) {
      const rawId = path.split('/')[2]
      const queueId = decodeURIComponent(rawId)
      let entry = null
      if (pool) {
        try {
          const resDb = await pool.query(`SELECT id, user_id AS "userId" FROM queue_entries WHERE id = $1`, [queueId])
          entry = resDb.rows[0]
          if (entry && entry.userId === user.id) {
            await pool.query(`DELETE FROM queue_entries WHERE id = $1`, [queueId])
          }
        } catch {
          entry = queueEntries.get(queueId)
          if (entry && entry.userId === user.id) queueEntries.delete(queueId)
        }
      } else {
        entry = queueEntries.get(queueId)
        if (entry && entry.userId === user.id) queueEntries.delete(queueId)
      }
      if (!entry || entry.userId !== user.id) {
        json(res, 404, { message: 'Очередь не найдена.' })
        return true
      }
      json(res, 200, { queue: null })
      return true
    }
    if (req.method === 'GET' && path === '/me/history') {
      json(res, 200, { history: [] })
      return true
    }
    return false
  } catch (error) {
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
  initDatabase()
    .then(() => server.listen(port, '0.0.0.0', () => console.log(`LabFlow API listening on http://0.0.0.0:${port}`)))
    .catch(error => {
      console.error('Database initialization failed:', error)
      process.exit(1)
    })
}
