import type { Lesson, Queue, QueueMember, Subject, User } from './types'
import { fetchDirectBsuirSchedule } from './scheduleParser'

const rawEnvUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const remoteBase = rawEnvUrl.includes('your-labflow-api') ? '' : rawEnvUrl
export const usingRemoteApi = true

const remoteToken = () => localStorage.getItem('labflow_token') || ''

async function remote<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 6000)

  try {
    const response = await fetch(`${remoteBase}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(remoteToken() ? { Authorization: `Bearer ${remoteToken()}` } : {}),
        ...(options.headers || {})
      }
    })
    clearTimeout(timeoutId)
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(data.message || data.code || 'API_ERROR')
    }
    return data as T
  } catch (err) {
    clearTimeout(timeoutId)
    throw err
  }
}

const STORAGE_USER_KEY = 'labflow_current_user'
const STORAGE_QUEUE_PREFIX = 'labflow_queue_members_'

// Cache loaded lessons in memory & session
let cachedLessons: Lesson[] = []

export const api = {
  getStoredUser(): User | null {
    try {
      const saved = localStorage.getItem(STORAGE_USER_KEY)
      return saved ? JSON.parse(saved) : null
    } catch {
      return null
    }
  },

  saveStoredUser(user: User) {
    try {
      localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(user))
    } catch {
      // ignore
    }
  },

  async login(group: string, password?: string, name?: string): Promise<User> {
    const cleanGroup = group.trim() || '668204'
    const cleanName = (name || '').trim()

    try {
      const data = await remote<{ user: User; token: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ group: cleanGroup, password: password || 'hedge67', name: cleanName })
      })
      if (data.token) {
        localStorage.setItem('labflow_token', data.token)
        const userObj: User = {
          name: cleanName || data.user.name || '',
          group: cleanGroup,
          notifications: true
        }
        this.saveStoredUser(userObj)
        return userObj
      }
    } catch (err) {
      console.warn('Remote login failed, falling back to local session:', err)
    }

    const localUser: User = {
      name: cleanName,
      group: cleanGroup,
      notifications: true
    }
    localStorage.setItem('labflow_token', 'local-token-' + Date.now())
    this.saveStoredUser(localUser)
    return localUser
  },

  async saveName(name: string, user?: User | null): Promise<User> {
    const cleanName = name.trim() || 'Студент'
    const baseUser = user || this.getStoredUser() || { group: '668204', notifications: true, name: '' }
    const updated: User = { ...baseUser, name: cleanName }
    this.saveStoredUser(updated)

    try {
      await remote<{ user: User }>('/me', {
        method: 'PATCH',
        body: JSON.stringify({ name: cleanName })
      })
    } catch (err) {
      console.warn('Remote saveName failed:', err)
    }

    return updated
  },

  async logout(): Promise<void> {
    localStorage.removeItem('labflow_token')
    localStorage.removeItem(STORAGE_USER_KEY)
    cachedLessons = []
  },

  async getUser(): Promise<User> {
    const stored = this.getStoredUser()
    if (stored) return stored
    try {
      const data = await remote<{ user: User }>('/me')
      if (data.user) {
        this.saveStoredUser(data.user)
        return data.user
      }
    } catch {}
    return { name: '', group: '668204', notifications: true }
  },

  async getUniversitySchedule(groupNumber?: string): Promise<Lesson[]> {
    const user = this.getStoredUser()
    const group = (groupNumber || user?.group || '668204').trim()

    // 1. Try backend /schedule
    try {
      const data = await remote<{ lessons: Lesson[] }>('/schedule')
      if (data.lessons && Array.isArray(data.lessons) && data.lessons.length > 0) {
        cachedLessons = data.lessons
        return data.lessons
      }
    } catch (err) {
      console.warn('Backend /schedule fetch error:', err)
    }

    // 2. Direct fetch from BSUIR API
    try {
      const direct = await fetchDirectBsuirSchedule(group)
      if (direct && direct.length > 0) {
        cachedLessons = direct
        return direct
      }
    } catch (err) {
      console.error('Direct BSUIR API schedule fetch error:', err)
    }

    return cachedLessons
  },

  async getSubjects(): Promise<Subject[]> {
    if (!cachedLessons.length) {
      await this.getUniversitySchedule()
    }
    const counts = new Map<string, number>()
    const names = new Map<string, string>()

    for (const l of cachedLessons) {
      const sId = l.subjectId || l.subject?.toLowerCase() || 'other'
      counts.set(sId, (counts.get(sId) || 0) + (l.lessonTypeAbbrev === 'ЛР' ? 1 : 0))
      if (!names.has(sId)) {
        names.set(sId, l.title && l.title !== l.subject ? `${l.subject} (${l.title})` : l.subject || sId)
      }
    }

    return Array.from(names.entries()).map(([id, name]) => ({
      id,
      name,
      labCount: counts.get(id) || 1
    }))
  },

  async getLessons(subjectId: string): Promise<Lesson[]> {
    if (!cachedLessons.length) {
      await this.getUniversitySchedule()
    }
    const target = subjectId.toLowerCase()
    return cachedLessons.filter(
      l =>
        l.subjectId.toLowerCase() === target ||
        (l.subject && l.subject.toLowerCase() === target) ||
        (l.subject && l.subject.toLowerCase().includes(target))
    )
  },

  async getLesson(id: string): Promise<Lesson | null> {
    if (!cachedLessons.length) {
      await this.getUniversitySchedule()
    }
    const found = cachedLessons.find(l => l.id === id)
    if (found) return found

    try {
      const data = await remote<{ lesson: Lesson }>(`/lessons/${id}`)
      if (data.lesson) return data.lesson
    } catch {}

    return null
  },

  async getQueueMembers(lessonId: string): Promise<QueueMember[]> {
    try {
      const data = await remote<{ members: QueueMember[] }>(`/lessons/${lessonId}/queue/members`)
      if (data.members && Array.isArray(data.members)) {
        localStorage.setItem(STORAGE_QUEUE_PREFIX + lessonId, JSON.stringify(data.members))
        return data.members
      }
    } catch (err) {
      console.warn('Remote queue members fetch failed, checking local storage:', err)
    }

    try {
      const local = localStorage.getItem(STORAGE_QUEUE_PREFIX + lessonId)
      return local ? JSON.parse(local) : []
    } catch {
      return []
    }
  },

  async getQueue(user?: User | null, lessonId = ''): Promise<Queue | null> {
    const currentUser = user || this.getStoredUser()
    if (!currentUser || !currentUser.name) return null

    let members: QueueMember[] = []
    if (lessonId) {
      members = await this.getQueueMembers(lessonId)
    }

    try {
      const data = await remote<{ queue: Queue | null }>('/me/queue')
      if (data.queue) {
        if (!lessonId) {
          members = await this.getQueueMembers(data.queue.lessonId)
        }
        data.queue.members = members
        return data.queue
      }
    } catch {}

    // Fallback: check local members
    const myIndex = members.findIndex(
      m => m.name.toLowerCase() === currentUser.name.toLowerCase() && m.status !== 'completed'
    )
    if (myIndex === -1) return null

    const member = members[myIndex]
    return {
      id: member.id,
      lessonId: lessonId || 'oaip',
      number: member.number,
      peopleAhead: myIndex,
      estimatedWaitMinutes: myIndex * 5,
      status: member.status,
      joinedAt: member.joinedAt,
      members
    }
  },

  async joinQueue(lessonId: string, user: User): Promise<Queue> {
    try {
      const data = await remote<{ queue: Queue }>(`/lessons/${lessonId}/queue/join`, {
        method: 'POST'
      })
      if (data.queue) {
        const members = await this.getQueueMembers(lessonId)
        data.queue.members = members
        return data.queue
      }
    } catch (err) {
      console.warn('Remote joinQueue failed, fallback to local queue:', err)
    }

    // Local fallback
    const members = await this.getQueueMembers(lessonId)
    const existing = members.find(m => m.name.toLowerCase() === user.name.toLowerCase())
    if (!existing) {
      const newMember: QueueMember = {
        id: 'member-' + Date.now(),
        number: members.length + 1,
        name: user.name || 'Студент',
        group: user.group || '668204',
        status: members.length === 0 ? 'serving' : members.length === 1 ? 'next' : 'waiting',
        joinedAt: new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date()),
        isCurrentUser: true
      }
      members.push(newMember)
      localStorage.setItem(STORAGE_QUEUE_PREFIX + lessonId, JSON.stringify(members))
    }

    const myIndex = members.findIndex(m => m.name.toLowerCase() === user.name.toLowerCase())
    const num = myIndex >= 0 ? members[myIndex].number : 1

    return {
      id: 'queue-' + Date.now(),
      lessonId,
      number: num,
      peopleAhead: Math.max(0, myIndex),
      estimatedWaitMinutes: Math.max(0, myIndex) * 5,
      status: myIndex === 0 ? 'serving' : myIndex === 1 ? 'next' : 'waiting',
      joinedAt: new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date()),
      members
    }
  },

  async leaveQueue(user: User, queueId?: string, lessonId?: string): Promise<void> {
    if (queueId) {
      try {
        await remote(`/queues/${queueId}/leave`, { method: 'DELETE' })
      } catch (err) {
        console.warn('Remote leaveQueue failed:', err)
      }
    }

    if (lessonId) {
      const members = (await this.getQueueMembers(lessonId)).filter(
        m => m.name.toLowerCase() !== user.name.toLowerCase()
      )
      // Renumber
      const renumbered = members.map((m, idx) => ({ ...m, number: idx + 1 }))
      localStorage.setItem(STORAGE_QUEUE_PREFIX + lessonId, JSON.stringify(renumbered))
    }
  },

  async history(): Promise<unknown[]> {
    try {
      const data = await remote<{ history: unknown[] }>('/me/history')
      if (data.history) return data.history
    } catch {}
    return []
  },

  async toggleNotifications(user: User): Promise<User> {
    const updated = { ...user, notifications: !user.notifications }
    this.saveStoredUser(updated)
    try {
      await remote('/me', {
        method: 'PATCH',
        body: JSON.stringify({ notifications: updated.notifications })
      })
    } catch {}
    return updated
  }
}
