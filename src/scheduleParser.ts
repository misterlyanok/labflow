import type { Lesson, RegistrationStatus } from './types'

const weekdayNames = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота']

const parseDate = (value: unknown): Date | null => {
  const text = String(value || '')
  const ru = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/)
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return ru ? new Date(`${ru[3]}-${ru[2]}-${ru[1]}T00:00:00`) : iso ? new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00`) : null
}

const isoDate = (date: Date): string => date.toISOString().slice(0, 10)

function expandWeeklyEntries(entries: any[], weekday: number, termStart: Date | null): any[] {
  if (!Array.isArray(entries)) return []
  const result: any[] = []
  entries.forEach((item, index) => {
    const start = parseDate(item.startLessonDate)
    const end = parseDate(item.endLessonDate)
    const oneOffDate = parseDate(item.dateLesson)
    const weeks = (Array.isArray(item.weekNumber) ? item.weekNumber : []).map(Number).filter(Boolean)
    const add = (date: Date) =>
      result.push({
        ...item,
        id: `${item.id || item.lessonId || item.subject || 'lesson'}-${isoDate(date)}-${item.startLessonTime || item.startTime || ''}-${index}`,
        date: isoDate(date)
      })

    if (oneOffDate) return add(oneOffDate)
    if (!start || !end || !weeks.length) return
    const cycleStart = termStart || start
    for (const date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
      if (date.getDay() !== weekday) continue
      const week = (Math.floor((date.getTime() - cycleStart.getTime()) / 86400000 / 7) % 4) + 1
      if (weeks.includes(week)) add(new Date(date))
    }
  })
  return result
}

export function expandJsonSchedule(payload: any): any[] {
  const schedules = payload?.schedules
  if (!schedules || Array.isArray(schedules) || typeof schedules !== 'object') {
    return Array.isArray(payload) ? payload : []
  }
  const termStart = parseDate(payload.startDate)
  const entries = Object.entries(schedules).flatMap(([dayName, lessonsForDay]) => {
    const weekday = weekdayNames.indexOf(dayName.toLowerCase())
    return weekday > 0 ? expandWeeklyEntries(lessonsForDay as any[], weekday, termStart) : []
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

  return source
    .map(({ item, outerDate }, index): Lesson => {
      const subject = String(item.subject || item.subjectName || item.subjectFullName || 'Занятие')
      const subjectId = String(item.subjectId || item.subjectCode || subject.toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-'))
      const title = String(item.title || item.name || item.subjectFullName || item.subject || `Занятие №${index + 1}`)
      const date = String(item.date || (isDate(item.dateLesson) ? item.dateLesson : '') || outerDate || (isDate(item.startLessonDate) ? item.startLessonDate : ''))
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
        registration
      }
    })
    .filter(item => item.date && item.startTime)
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
