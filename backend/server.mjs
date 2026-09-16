import http from 'node:http'
import { randomUUID } from 'node:crypto'

const port = Number(process.env.PORT || 8787)
const universityScheduleUrl = process.env.UNIVERSITY_SCHEDULE_URL || ''
const users = new Map()
const sessions = new Map()
const queueEntries = new Map()

const lessons = [
  { id: 'p3', subject: 'Программирование', title: 'Лабораторная №3', date: '2026-09-15', startTime: '14:30', endTime: '16:00', teacher: 'Иванов А.А.', room: '204', registrationStatus: 'open' }
]

function normalizeLessons(payload) {
  const candidate = Array.isArray(payload) ? payload : payload?.lessons || payload?.schedule || payload?.schedules || payload?.data || payload?.items || payload
  const source = Array.isArray(candidate)
    ? candidate
    : candidate && (candidate.subject || candidate.subjectFullName || candidate.startLessonTime)
      ? [candidate]
      : candidate && typeof candidate === 'object'
        ? Object.values(candidate).flatMap(value => Array.isArray(value) ? value : [])
        : []
  return source.map((item, index) => ({
    id: String(item.id || item.lessonId || item.universityId || `university-lesson-${index + 1}`),
    subject: String(item.subject || item.subjectName || 'Лабораторная'),
    subjectId: String(item.subjectId || item.subjectCode || (item.subject || item.subjectName || 'lab').toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-')),
    title: String(item.title || item.name || `Лабораторная №${index + 1}`),
    date: String(item.date || item.day || item.dateLesson || item.startLessonDate || ''),
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

async function getUniversitySchedule(groupNumber) {
  if (!universityScheduleUrl) {
    console.log('Schedule source: local mock')
    return lessons
  }
  const requestUrl = universityScheduleUrl.replaceAll('{groupNumber}', encodeURIComponent(groupNumber))
  console.log(`Schedule request: ${requestUrl}`)
  let response
  try {
    response = await fetch(requestUrl, { headers: { Accept: 'application/json', 'User-Agent': 'LabFlow/1.0' } })
  } catch (error) {
    console.error('Schedule upstream network error:', error instanceof Error ? error.message : error)
    throw new Error('University schedule network error')
  }
  if (!response.ok) {
    const details = await response.text().catch(() => '')
    console.error(`Schedule upstream HTTP ${response.status}:`, details.slice(0, 500))
    throw new Error(`University schedule returned ${response.status}`)
  }
  const payload = await response.json()
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

function userFromRequest(req) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  const userId = sessions.get(token)
  return userId ? users.get(userId) : null
}

function queueForUser(userId) {
  return [...queueEntries.values()].find(entry => entry.userId === userId) || null
}

function queueResponse(entry) {
  if (!entry) return null
  const sameLesson = [...queueEntries.values()].filter(item => item.lessonId === entry.lessonId).sort((a, b) => a.number - b.number)
  return { ...entry, peopleAhead: sameLesson.filter(item => item.number < entry.number).length, estimatedWaitMinutes: sameLesson.filter(item => item.number < entry.number).length * 5 }
}

const server = http.createServer(async (req, res) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`)
  if (req.method === 'OPTIONS') return json(res, 204, {})
  try {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const path = url.pathname

    if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true, service: 'labflow-api' })

    if (req.method === 'POST' && path === '/auth/login') {
      const { group, password } = await body(req)
      if (group !== '668204' || password !== 'hedge67') return json(res, 401, { code: 'INVALID_CREDENTIALS', message: 'Неверная группа или пароль.' })
      const user = { id: randomUUID(), telegramId: null, name: '', group, notifications: true }
      users.set(user.id, user)
      const token = randomUUID()
      sessions.set(token, user.id)
      return json(res, 200, { user, token })
    }

    const user = userFromRequest(req)
    if (!user) return json(res, 401, { code: 'UNAUTHORIZED', message: 'Сессия недействительна.' })

    if (req.method === 'GET' && path === '/me') return json(res, 200, { user })
    if (req.method === 'PATCH' && path === '/me') {
      const data = await body(req)
      if (typeof data.name === 'string' && data.name.trim()) user.name = data.name.trim()
      if (typeof data.notifications === 'boolean') user.notifications = data.notifications
      return json(res, 200, { user })
    }
    if (req.method === 'GET' && path === '/schedule') return json(res, 200, { lessons: await getUniversitySchedule(user.group) })
    if (req.method === 'GET' && path.startsWith('/lessons/')) {
      const lessonId = path.split('/')[2]
      const lesson = (await getUniversitySchedule(user.group)).find(item => item.id === lessonId)
      return lesson ? json(res, 200, { lesson }) : json(res, 404, { message: 'Лабораторная не найдена.' })
    }
    if (req.method === 'GET' && path === '/me/queue') return json(res, 200, { queue: queueResponse(queueForUser(user.id)) })
    if (req.method === 'POST' && path.match(/^\/lessons\/[^/]+\/queue\/join$/)) {
      const lessonId = path.split('/')[2]
      const lesson = (await getUniversitySchedule(user.group)).find(item => item.id === lessonId)
      if (!lesson || lesson.registrationStatus !== 'open') return json(res, 409, { message: 'Регистрация закрыта.' })
      if (queueForUser(user.id)) return json(res, 409, { message: 'Вы уже в очереди.' })
      const existing = [...queueEntries.values()].filter(item => item.lessonId === lessonId)
      const entry = { id: randomUUID(), userId: user.id, lessonId, number: existing.length + 1, status: 'waiting', joinedAt: new Date().toISOString() }
      queueEntries.set(entry.id, entry)
      return json(res, 201, { queue: queueResponse(entry) })
    }
    if (req.method === 'DELETE' && path.match(/^\/queues\/[^/]+\/leave$/)) {
      const queueId = path.split('/')[2]
      const entry = queueEntries.get(queueId)
      if (!entry || entry.userId !== user.id) return json(res, 404, { message: 'Очередь не найдена.' })
      queueEntries.delete(queueId)
      return json(res, 200, { queue: null })
    }
    if (req.method === 'GET' && path === '/me/history') return json(res, 200, { history: [] })
    return json(res, 404, { message: 'Маршрут не найден.' })
  } catch (error) {
    console.error(error)
    return json(res, 500, { message: 'Внутренняя ошибка сервера.' })
  }
})

server.listen(port, '0.0.0.0', () => console.log(`LabFlow API listening on http://0.0.0.0:${port}`))
