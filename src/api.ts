import type { Lesson, Queue, QueueView, Subject, User } from './types'
import { fetchDirectBsuirSchedule, isLabLesson } from './scheduleParser'

const rawEnvUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const remoteBase = rawEnvUrl.includes('your-labflow-api') ? '' : rawEnvUrl

const remoteToken = () => localStorage.getItem('labflow_token') || ''

// Тихий перелогин по сохранённым группе+имени: сессии в памяти сервера живут
// до его перезапуска, а токен в localStorage — дольше. На 401 восстанавливаем
// сессию автоматически, upsert на бэкенде вернёт того же пользователя.
async function silentRelogin(): Promise<boolean> {
  const stored = api.getStoredUser()
  if (!stored?.name) return false
  try {
    const response = await fetch(`${remoteBase}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        group: stored.group || '668204',
        name: stored.name,
        subgroup: stored.subgroup || 1
      })
    })
    if (!response.ok) return false
    const data = await response.json().catch(() => null)
    if (!data?.token) return false
    localStorage.setItem('labflow_token', data.token)
    if (data.user?.id) {
      api.saveStoredUser({ ...stored, id: data.user.id })
    }
    return true
  } catch {
    return false
  }
}

async function remote<T>(path: string, options: RequestInit = {}, retried = false): Promise<T> {
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
      if (data.code === 'UNAUTHORIZED' && !retried && path !== '/auth/login') {
        if (await silentRelogin()) {
          return await remote<T>(path, options, true)
        }
      }
      throw new Error(data.message || data.code || 'API_ERROR')
    }
    return data as T
  } catch (err) {
    clearTimeout(timeoutId)
    throw err
  }
}

// Живой ли сервер очередей и есть ли под ним база. В деве API поднят
// мидлварью Vite на том же origin, на Pages — только если задан VITE_API_URL.
// db: false — сервер жив, но очередь держит в памяти и при рестарте обнулится.
export async function checkBackendHealth(): Promise<{ online: boolean; db: boolean }> {
  try {
    const data = await remote<{ ok: boolean; db?: boolean }>('/health')
    return { online: true, db: Boolean(data.db) }
  } catch {
    return { online: false, db: false }
  }
}

const STORAGE_USER_KEY = 'labflow_current_user'

// Cache loaded lessons in memory
let cachedLessons: Lesson[] = []

export const api = {
  getStoredUser(): User | null {
    try {
      const saved = localStorage.getItem(STORAGE_USER_KEY)
      if (!saved) return null
      const parsed = JSON.parse(saved)
      if (parsed && typeof parsed === 'object') {
        parsed.subgroup = Number(parsed.subgroup) === 2 ? 2 : 1
      }
      return parsed
    } catch {
      return null
    }
  },

  saveStoredUser(user: User) {
    try {
      const normalized: User = {
        ...user,
        subgroup: Number(user.subgroup) === 2 ? 2 : 1
      }
      localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(normalized))
    } catch {
      // ignore
    }
  },

  async login(group: string, name?: string, subgroup?: 1 | 2): Promise<User> {
    const cleanGroup = group.trim() || '668204'
    const cleanName = (name || '').trim() || 'Студент'
    const existing = this.getStoredUser()
    const cleanSubgroup: 1 | 2 = subgroup || existing?.subgroup || 1

    try {
      const data = await remote<{ user: User; token: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          group: cleanGroup,
          name: cleanName,
          subgroup: cleanSubgroup
        })
      })
      if (data.token) {
        localStorage.setItem('labflow_token', data.token)
        const userObj: User = {
          id: data.user?.id,
          name: cleanName || data.user.name || '',
          group: cleanGroup,
          notifications: true,
          subgroup: Number(data.user?.subgroup) === 2 ? 2 : cleanSubgroup
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
      notifications: true,
      subgroup: cleanSubgroup
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
      if (isLabLesson(l)) counts.set(sId, (counts.get(sId) || 0) + 1)
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

  async getQueueMembers(lessonId: string): Promise<QueueView> {
    try {
      const data = await remote<QueueView>(`/lessons/${lessonId}/queue/members`)
      return {
        members: Array.isArray(data.members) ? data.members : [],
        completed: Array.isArray(data.completed) ? data.completed : [],
        currentLabNo: data.currentLabNo ?? null
      }
    } catch (err) {
      console.warn('Remote queue members fetch failed:', err)
      return { members: [], completed: [], currentLabNo: null }
    }
  },

  async getQueue(): Promise<Queue | null> {
    try {
      const data = await remote<{ queue: Queue | null }>('/me/queue')
      if (!data.queue) return null
      if (!data.queue.members) {
        const view = await this.getQueueMembers(data.queue.lessonId)
        data.queue.members = view.members
        data.queue.completed = view.completed
        data.queue.currentLabNo = view.currentLabNo
      }
      return data.queue
    } catch (err) {
      console.warn('Remote getQueue failed:', err)
      return null
    }
  },

  async joinQueue(lessonId: string, labNo: number): Promise<Queue> {
    // Намеренно без локального фолбэка: выдуманный номер в localStorage
    // видел только сам пользователь, а сервер — нет.
    const data = await remote<{ queue: Queue }>(`/lessons/${lessonId}/queue/join`, {
      method: 'POST',
      body: JSON.stringify({ labNo })
    })
    const view = await this.getQueueMembers(lessonId)
    data.queue.members = view.members
    data.queue.completed = view.completed
    data.queue.currentLabNo = view.currentLabNo
    return data.queue
  },

  async leaveQueue(): Promise<void> {
    await remote('/me/queue', { method: 'DELETE' })
  },

  async completeQueue(): Promise<void> {
    await remote('/me/queue/complete', { method: 'POST' })
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
  },

  async setSubgroup(user: User, subgroup: 1 | 2): Promise<User> {
    const updated: User = { ...user, subgroup }
    this.saveStoredUser(updated)
    try {
      await remote('/me', {
        method: 'PATCH',
        body: JSON.stringify({ subgroup })
      })
    } catch {}
    return updated
  }
}
