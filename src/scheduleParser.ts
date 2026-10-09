import type { Lesson, RegistrationStatus } from './types'

export const weekdayNames = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота']

export const parseDate = (value: unknown): Date | null => {
  const text = String(value || '').trim()
  const ru = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/)
  if (ru) {
    return new Date(Number(ru[3]), Number(ru[2]) - 1, Number(ru[1]), 12, 0, 0)
  }
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) {
    return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12, 0, 0)
  }
  return null
}

export const formatYMD = (date: Date): string => {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export const toStandardDate = (value: unknown): string => {
  const d = parseDate(value)
  return d ? formatYMD(d) : ''
}

export function isLessonEnded(lesson: Lesson | null | undefined): boolean {
  if (!lesson || !lesson.date) return false
  const now = new Date()
  const todayYMD = formatYMD(now)

  if (lesson.date < todayYMD) return true
  if (lesson.date > todayYMD) return false

  if (!lesson.endTime) return false
  const [endH, endM] = lesson.endTime.split(':').map(Number)
  if (isNaN(endH) || isNaN(endM)) return false

  const currentTotal = now.getHours() * 60 + now.getMinutes()
  const endTotal = endH * 60 + endM

  return currentTotal >= endTotal
}

export function extractSubgroup(item: any): number {
  if (!item || typeof item !== 'object') return 0
  const raw = Number(item.numSubgroup ?? item.subgroup ?? item.subGroup ?? 0)
  if (raw === 1 || raw === 2) return raw

  const text = `${item.note || ''} ${item.title || ''}`
  if (/(?:^|\s|[,;(])1(?:\s*-?я)?\s*(?:подгрупп|п\/г|пг)/i.test(text) || /(?:подгрупп[аы]?|п\/г)\s*№?\s*1\b/i.test(text)) {
    return 1
  }
  if (/(?:^|\s|[,;(])2(?:\s*-?я)?\s*(?:подгрупп|п\/г|пг)/i.test(text) || /(?:подгрупп[аы]?|п\/г)\s*№?\s*2\b/i.test(text)) {
    return 2
  }
  return 0
}

export function isLessonForSubgroup(lesson: Lesson, userSubgroup?: 1 | 2): boolean {
  if (!userSubgroup) return true
  if (!lesson.subgroup || lesson.subgroup === 0) return true
  return lesson.subgroup === userSubgroup
}

export function getWeekNumber(
  date: Date,
  termStart: Date | null,
  currentWeek?: number,
  todayDate?: Date | null
): number {
  if (currentWeek && todayDate) {
    const dayOfWeekToday = (todayDate.getDay() + 6) % 7 // Monday = 0, Sunday = 6
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

  // Fallback: estimate based on autumn or spring semester start
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

function expandWeeklyEntries(
  entries: any[],
  weekday: number,
  termStart: Date | null,
  termEnd: Date | null,
  currentWeek?: number,
  todayDate?: Date | null
): any[] {
  if (!Array.isArray(entries)) return []
  const result: any[] = []
  entries.forEach((item, index) => {
    const start = parseDate(item.startLessonDate) || termStart
    const end = parseDate(item.endLessonDate) || termEnd
    const oneOffDate = parseDate(item.dateLesson)
    const weeks = (Array.isArray(item.weekNumber) ? item.weekNumber : []).map(Number).filter(Boolean)

    const sub = extractSubgroup(item)
    const add = (date: Date) => {
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

    for (const cur = new Date(start); cur <= end; cur.setDate(cur.getDate() + 1)) {
      if (cur.getDay() !== weekday) continue
      const week = getWeekNumber(cur, termStart, currentWeek, todayDate)
      if (weeks.includes(week)) {
        add(new Date(cur))
      }
    }
  })
  return result
}

export function expandJsonSchedule(payload: any): any[] {
  const schedules = payload?.schedules
  if (!schedules || Array.isArray(schedules) || typeof schedules !== 'object') {
    return Array.isArray(payload) ? payload : []
  }
  const termStart = parseDate(payload.startDate || payload.dateStart)
  const termEnd = parseDate(payload.endDate || payload.dateEnd)
  const currentWeek = Number(payload.currentWeekNumber) || undefined
  const todayDate = parseDate(payload.todayDate)

  const entries = Object.entries(schedules).flatMap(([dayName, lessonsForDay]) => {
    const weekday = weekdayNames.indexOf(dayName.toLowerCase())
    return weekday > 0
      ? expandWeeklyEntries(lessonsForDay as any[], weekday, termStart, termEnd, currentWeek, todayDate)
      : []
  })
  return entries
}

export function normalizeLessons(payload: any): Lesson[] {
  const candidate = Array.isArray(payload) ? payload : payload?.lessons || payload?.schedule || payload?.schedules || payload
  const isDate = (value: unknown): boolean =>
    typeof value === 'string' && (/^\d{4}-\d{2}-\d{2}/.test(value) || /^\d{2}\.\d{2}\.\d{4}$/.test(value))

  const source: { item: any; outerDate?: string }[] = Array.isArray(candidate)
    ? candidate.map(item => ({ item }))
    : candidate && typeof candidate === 'object'
    ? Object.entries(candidate).flatMap(([key, value]) =>
        Array.isArray(value) ? value.map(item => ({ item, outerDate: isDate(key) ? key : '' })) : []
      )
    : []

  const mapped: Lesson[] = source
    .map(({ item, outerDate }, index): Lesson => {
      const subject = String(item.subject || item.subjectName || item.subjectFullName || 'Занятие')
      const subjectId = String(item.subjectId || item.subjectCode || subject.toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-'))
      const title = String(item.title || item.name || item.subjectFullName || item.subject || `Занятие №${index + 1}`)
      const rawDate = String(item.date || (isDate(item.dateLesson) ? item.dateLesson : '') || outerDate || (isDate(item.startLessonDate) ? item.startLessonDate : ''))
      const date = toStandardDate(rawDate) || rawDate
      const startTime = String(item.startTime || item.start || item.startLessonTime || item.timeFrom || '')
      const endTime = String(item.endTime || item.end || item.endLessonTime || item.timeTo || '')

      let teacher: string | undefined = item.teacher || item.instructor
      if (!teacher && Array.isArray(item.employees) && item.employees[0]) {
        const emp = item.employees[0]
        teacher = [emp.lastName, emp.firstName, emp.middleName].filter(Boolean).join(' ')
      }

      let room: string | undefined = item.room || item.classroom
      if (!room && Array.isArray(item.auditories) && item.auditories[0]) {
        room = String(item.auditories[0])
      }

      const lessonTypeAbbrev: string | undefined = item.lessonTypeAbbrev || undefined
      const subgroup = extractSubgroup(item)
      const registration: RegistrationStatus = (item.registration || item.registrationStatus || 'open') as RegistrationStatus

      return {
        id: String(item.id || item.lessonId || item.universityId || `lesson-${index + 1}`),
        subject,
        subjectId,
        title,
        date,
        startTime,
        endTime,
        teacher,
        room,
        note: item.note || undefined,
        lessonTypeAbbrev,
        subgroup,
        registration
      }
    })
    .filter(item => item.date && item.startTime)

  // CRITICAL: Sort chronologically by date ascending, then startTime ascending, then subgroup
  mapped.sort((a, b) => {
    const dateCmp = a.date.localeCompare(b.date)
    if (dateCmp !== 0) return dateCmp
    const timeCmp = a.startTime.localeCompare(b.startTime)
    if (timeCmp !== 0) return timeCmp
    return (a.subgroup || 0) - (b.subgroup || 0)
  })

  return mapped
}

export async function fetchDirectBsuirSchedule(groupNumber: string): Promise<Lesson[]> {
  const clean = groupNumber.trim() || '668204'
  const url = `https://iis.bsuir.by/api/v1/schedule?studentGroup=${encodeURIComponent(clean)}`
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'LabFlow/1.0' }
  })
  if (!res.ok) {
    throw new Error(`BSUIR schedule API returned ${res.status}`)
  }
  const data = await res.json()
  const expanded = expandJsonSchedule(data)
  return normalizeLessons(expanded)
}
