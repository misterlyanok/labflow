import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api, usingRemoteApi } from './api'
import { isLessonEnded, isLessonForSubgroup } from './scheduleParser'
import type { Lesson, Queue, QueueMember, Screen, User } from './types'
import './styles.css'

const statusCopy: Record<string, string> = {
  waiting: 'В очереди',
  next: 'Вы следующий',
  called: 'Вас вызывают',
  serving: 'На защите',
  completed: 'Сдал работу'
}

export function getPrimaryOaipLesson(schedule: Lesson[], userSubgroup?: 1 | 2): Lesson | null {
  if (!schedule || !schedule.length) return null
  const now = new Date()
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

  const filtered = userSubgroup ? schedule.filter(l => isLessonForSubgroup(l, userSubgroup)) : schedule
  const pool = filtered.length > 0 ? filtered : schedule

  // 1. Upcoming OAIP lab (today or later)
  const upcomingLab = pool.find(
    l =>
      (l.subject?.toLowerCase().includes('оаип') || l.title?.toLowerCase().includes('оаип')) &&
      (l.lessonTypeAbbrev === 'ЛР' || l.lessonTypeAbbrev === 'Лаб') &&
      l.date >= todayStr
  )
  if (upcomingLab) return upcomingLab

  // 2. Upcoming any OAIP lesson
  const upcomingAny = pool.find(
    l =>
      (l.subject?.toLowerCase().includes('оаип') || l.title?.toLowerCase().includes('оаип')) &&
      l.date >= todayStr
  )
  if (upcomingAny) return upcomingAny

  // 3. Fallback: any OAIP lab
  const anyLab = pool.find(
    l =>
      (l.subject?.toLowerCase().includes('оаип') || l.title?.toLowerCase().includes('оаип')) &&
      (l.lessonTypeAbbrev === 'ЛР' || l.lessonTypeAbbrev === 'Лаб')
  )
  if (anyLab) return anyLab

  // 4. Any OAIP lesson
  const anyOaip = pool.find(
    l => l.subject?.toLowerCase().includes('оаип') || l.title?.toLowerCase().includes('оаип')
  )
  if (anyOaip) return anyOaip

  return pool[0] || null
}

function App() {
  const [user, setUser] = useState<User | null>(() => api.getStoredUser())
  const [screen, setScreen] = useState<Screen>('home')
  const [lesson, setLesson] = useState<Lesson | null>(null)
  const [queue, setQueue] = useState<Queue | null>(null)
  const [queueMembers, setQueueMembers] = useState<QueueMember[]>([])
  const [lessons, setLessons] = useState<Lesson[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Form states: prefilled with student's real group and defaults
  const [loginGroup, setLoginGroup] = useState(user?.group || '668204')
  const [loginName, setLoginName] = useState(user?.name || '')
  const [loginPassword, setLoginPassword] = useState('hedge67')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const loadAppData = async (currentUser: User) => {
    if (!currentUser) return
    setLoading(true)
    setError('')
    try {
      const schedule = await api.getUniversitySchedule(currentUser.group)
      setLessons(schedule)

      const targetOaip = getPrimaryOaipLesson(schedule, currentUser.subgroup || 1)

      if (targetOaip) {
        setLesson(targetOaip)
        if (isLessonEnded(targetOaip)) {
          setQueue(null)
          setQueueMembers([])
        } else {
          const [activeQueue, members] = await Promise.all([
            api.getQueue(currentUser, targetOaip.id),
            api.getQueueMembers(targetOaip.id)
          ])
          setQueue(activeQueue)
          setQueueMembers(members)
        }
      }
    } catch (err: any) {
      console.warn('Failed to load schedule:', err)
      setError('Не удалось загрузить расписание. Проверьте соединение.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (user && user.name) {
      loadAppData(user)
    }
  }, [user?.group, user?.name])

  // Periodic polling for queue sync across different devices/browsers
  useEffect(() => {
    if (!user || !user.name || !lesson) return
    const interval = setInterval(async () => {
      try {
        if (isLessonEnded(lesson)) {
          setQueue(null)
          setQueueMembers([])
          return
        }
        const [activeQueue, members] = await Promise.all([
          api.getQueue(user, lesson.id),
          api.getQueueMembers(lesson.id)
        ])
        setQueue(activeQueue)
        setQueueMembers(members)
      } catch (e) {
        // silent background sync
      }
    }, 4000)
    return () => clearInterval(interval)
  }, [user?.name, lesson?.id])

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (isSubmitting) return
    setIsSubmitting(true)
    setError('')

    const cleanGroup = loginGroup.trim() || '668204'
    const cleanName = loginName.trim() || 'Студент'

    try {
      const u = await api.login(cleanGroup, loginPassword, cleanName)
      setUser(u)
      await loadAppData(u)
    } catch (err: any) {
      setError(err?.message || 'Не удалось выполнить вход')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleLogout = async () => {
    await api.logout()
    setUser(null)
    setQueue(null)
    setQueueMembers([])
    setLessons([])
    setScreen('home')
  }

  // Unified single-screen login: group, name, and password
  if (!user || !user.name) {
    return (
      <main className="auth">
        <div className="brand">
          <div className="logo">L</div>
          <h1>LabFlow</h1>
          <p>Электронная очередь по предмету ОАиП</p>
        </div>

        <form onSubmit={handleLoginSubmit} className="panel">
          <label>
            Студенческая группа
            <input
              value={loginGroup}
              onChange={e => setLoginGroup(e.target.value)}
              placeholder="Например, 668204"
              required
            />
          </label>
          <label>
            Ваше имя и фамилия
            <input
              autoFocus
              value={loginName}
              onChange={e => setLoginName(e.target.value)}
              placeholder="Например, Алексей Смирнов"
              required
            />
          </label>
          <label>
            Пароль
            <input
              type="password"
              value={loginPassword}
              onChange={e => setLoginPassword(e.target.value)}
              placeholder="Введите пароль"
              required
            />
          </label>

          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Вход...' : 'Войти в LabFlow'}
          </button>

          {error && <p className="error">{error}</p>}
        </form>
      </main>
    )
  }

  const openLesson = async (l: Lesson) => {
    setLoading(true)
    try {
      const full = (await api.getLesson(l.id)) || l
      setLesson(full)
      const [q, members] = await Promise.all([
        api.getQueue(user, full.id),
        api.getQueueMembers(full.id)
      ])
      setQueue(q)
      setQueueMembers(members)
      setScreen('lesson')
    } finally {
      setLoading(false)
    }
  }

  const openQueue = async (targetLesson?: Lesson) => {
    const currentLesson = targetLesson || lesson || lessons[0]
    if (!currentLesson) return
    setLoading(true)
    try {
      setLesson(currentLesson)
      if (isLessonEnded(currentLesson)) {
        setQueue(null)
        setQueueMembers([])
      } else {
        const [q, members] = await Promise.all([
          api.getQueue(user, currentLesson.id),
          api.getQueueMembers(currentLesson.id)
        ])
        setQueue(q)
        setQueueMembers(members)
      }
      setScreen('queue')
    } finally {
      setLoading(false)
    }
  }

  const joinQueue = async () => {
    if (!user) return
    const currentLesson = lesson || lessons[0]
    if (!currentLesson) return
    if (isLessonEnded(currentLesson)) {
      setError('Эта пара уже закончилась. Запись в очередь закрыта.')
      return
    }
    setLoading(true)
    setError('')
    try {
      const q = await api.joinQueue(currentLesson.id, user)
      const members = await api.getQueueMembers(currentLesson.id)
      setQueue(q)
      setQueueMembers(members)
      setScreen('queue')
    } catch (err: any) {
      setError(err?.message || 'Не удалось встать в очередь')
    } finally {
      setLoading(false)
    }
  }

  const leaveQueue = async () => {
    if (!user) return
    setLoading(true)
    setError('')
    try {
      const currentLessonId = lesson?.id || ''
      await api.leaveQueue(user, queue?.id, currentLessonId)
      setQueue(null)
      const members = await api.getQueueMembers(currentLessonId)
      setQueueMembers(members)
    } catch (err: any) {
      setError(err?.message || 'Не удалось покинуть очередь')
    } finally {
      setLoading(false)
    }
  }

  const resetQueue = async () => {
    if (!lesson) return
    setLoading(true)
    setError('')
    try {
      await api.resetQueue(lesson.id)
      setQueue(null)
      setQueueMembers([])
    } catch (err: any) {
      setError(err?.message || 'Не удалось сбросить очередь')
    } finally {
      setLoading(false)
    }
  }

  const handleSubgroupChange = async (sg: 1 | 2) => {
    if (!user) return
    const updated = await api.setSubgroup(user, sg)
    setUser(updated)
    const targetOaip = getPrimaryOaipLesson(lessons, sg)
    if (targetOaip) {
      setLesson(targetOaip)
      if (isLessonEnded(targetOaip)) {
        setQueue(null)
        setQueueMembers([])
      } else {
        try {
          const [activeQueue, members] = await Promise.all([
            api.getQueue(updated, targetOaip.id),
            api.getQueueMembers(targetOaip.id)
          ])
          setQueue(activeQueue)
          setQueueMembers(members)
        } catch {}
      }
    }
  }

  return (
    <div className="app">
      <header>
        <button className="wordmark" onClick={() => setScreen('home')}>
          <span className="logo small">L</span>
          LabFlow
        </button>
        {screen !== 'home' && (
          <button
            className="back"
            onClick={() => setScreen(screen === 'lesson' ? 'schedule' : screen === 'queue' ? 'home' : 'home')}
          >
            ← Назад
          </button>
        )}
      </header>

      <div className="content">
        {error && (
          <div className="error banner">
            {error}
            <button onClick={() => setError('')}>×</button>
          </div>
        )}

        {loading && lessons.length === 0 ? (
          <Skeleton />
        ) : (
          <>
            {screen === 'home' && (
              <Home
                user={user}
                queue={queue}
                lessons={lessons}
                onOpenQueue={() => {
                  const target = getPrimaryOaipLesson(lessons, user.subgroup || 1) || lesson
                  if (target) openQueue(target)
                }}
                onOpenLesson={openLesson}
              />
            )}

            {screen === 'schedule' && (
              <ScheduleView
                lessons={lessons}
                userSubgroup={user.subgroup || 1}
                onOpen={openLesson}
                onOpenQueue={openQueue}
              />
            )}

            {screen === 'lesson' && lesson && (
              <LessonDetails
                lesson={lesson}
                queue={queue}
                members={queueMembers}
                onJoin={joinQueue}
                onQueue={() => openQueue(lesson)}
              />
            )}

            {screen === 'queue' && (
              <QueueView
                queue={queue}
                lesson={lesson || lessons[0]}
                user={user}
                members={queueMembers}
                onJoin={joinQueue}
                onLeave={leaveQueue}
                onReset={resetQueue}
                onRefresh={async () => {
                  if (!lesson) return
                  const [q, mems] = await Promise.all([
                    api.getQueue(user, lesson.id),
                    api.getQueueMembers(lesson.id)
                  ])
                  setQueue(q)
                  setQueueMembers(mems)
                }}
              />
            )}

            {screen === 'profile' && (
              <Profile
                user={user}
                onChangeSubgroup={handleSubgroupChange}
                onToggle={async () => setUser(await api.toggleNotifications(user))}
                onHistory={() => setScreen('history')}
                onLogout={handleLogout}
              />
            )}

            {screen === 'history' && <History />}
          </>
        )}
      </div>

      <nav>
        <button className={screen === 'home' ? 'active' : ''} onClick={() => setScreen('home')}>
          ⌂<span>Главная</span>
        </button>
        <button
          className={screen === 'queue' ? 'active' : ''}
          onClick={() => {
            const target = getPrimaryOaipLesson(lessons, user.subgroup || 1) || lesson
            if (target) openQueue(target)
          }}
        >
          ☰<span>Очередь</span>
        </button>
        <button className={screen === 'schedule' ? 'active' : ''} onClick={() => setScreen('schedule')}>
          ▤<span>Расписание</span>
        </button>
        <button
          className={['profile', 'history'].includes(screen) ? 'active' : ''}
          onClick={() => setScreen('profile')}
        >
          ◯<span>Профиль</span>
        </button>
      </nav>
    </div>
  )
}

const Skeleton = () => (
  <div className="skeleton">
    <i />
    <i />
    <i />
    <i />
  </div>
)

function Home({
  user,
  queue,
  lessons,
  onOpenQueue,
  onOpenLesson
}: {
  user: User
  queue: Queue | null
  lessons: Lesson[]
  onOpenQueue: () => void
  onOpenLesson: (l: Lesson) => void
}) {
  const oaipLesson = getPrimaryOaipLesson(lessons, user.subgroup || 1)

  return (
    <>
      <section className="hero">
        <p className="eyebrow">ПРЕДМЕТ ОАиП</p>
        <h1>Привет, {user.name} 👋</h1>
        <p className="muted">
          Группа: {user.group} · Подгруппа {user.subgroup || 1} · Основы алгоритмизации и программирования
        </p>
      </section>

      {queue ? (
        <button className="queue-card" onClick={onOpenQueue}>
          <div>
            <p className="eyebrow">ВАШЕ МЕСТО В ОЧЕРЕДИ ПО ОАиП</p>
            <strong>№{queue.number}</strong>
            <p>
              {queue.peopleAhead === 0
                ? 'Вы у преподавателя на защите'
                : `${queue.peopleAhead} чел. перед вами · ~${queue.estimatedWaitMinutes} мин`}
            </p>
          </div>
          <span>Открыть очередь →</span>
        </button>
      ) : (
        <button className="queue-card" onClick={onOpenQueue}>
          <div>
            <p className="eyebrow">ЭЛЕКТРОННАЯ ОЧЕРЕДЬ · ОАиП</p>
            <strong>ОАиП</strong>
            <p>Посмотреть очередь и занять место</p>
          </div>
          <span>Войти в очередь →</span>
        </button>
      )}

      <div className="section-title">
        <h2>Ближайшая лабораторная</h2>
        <span className="muted">ОАиП · {user.subgroup || 1} подгруппа</span>
      </div>

      {oaipLesson ? (
        <button className="lesson-card lab-highlight" onClick={() => onOpenLesson(oaipLesson)}>
          <div>
            <h3>{oaipLesson.subject || 'ОАиП'}</h3>
            <p>{oaipLesson.title}</p>
            {oaipLesson.teacher && <small style={{ color: '#8ec8ee' }}>{oaipLesson.teacher}</small>}
            {oaipLesson.room && <small style={{ color: '#68a1c9', display: 'block' }}>Аудитория: {oaipLesson.room}</small>}
            <em className="lesson-kind">
              {oaipLesson.lessonTypeAbbrev || 'Лабораторная'}
              {oaipLesson.subgroup === 1 || oaipLesson.subgroup === 2 ? ` · ${oaipLesson.subgroup} подгруппа` : ''}
            </em>
          </div>
          <time>
            {oaipLesson.date}
            <br />
            <b>{oaipLesson.startTime}</b>
          </time>
        </button>
      ) : (
        <div className="hint">Загрузка расписания из университетского сервиса...</div>
      )}
    </>
  )
}

function QueueView({
  queue,
  lesson,
  user,
  members,
  onJoin,
  onLeave,
  onReset,
  onRefresh
}: {
  queue: Queue | null
  lesson: Lesson | null
  user: User
  members: QueueMember[]
  onJoin: () => void
  onLeave: () => void
  onReset?: () => void
  onRefresh?: () => void
}) {
  const [refreshing, setRefreshing] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)

  const isEnded = isLessonEnded(lesson)
  const activeMembers = isEnded ? [] : members.filter(m => m.status !== 'completed')
  const servingMember = isEnded ? null : members.find(m => m.status === 'serving')
  const isUserInQueue = Boolean(queue && !isEnded)

  const handleManualRefresh = async () => {
    if (!onRefresh || refreshing) return
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setTimeout(() => setRefreshing(false), 500)
    }
  }

  return (
    <>
      <p className="eyebrow">ЭЛЕКТРОННАЯ ОЧЕРЕДЬ · ОАиП</p>
      <h1>{lesson?.title || 'Лабораторная работа по ОАиП'}</h1>
      <p className="muted">
        {[
          lesson?.subgroup === 1 || lesson?.subgroup === 2 ? `${lesson.subgroup} подгруппа` : '',
          lesson?.teacher,
          lesson?.room ? `Ауд. ${lesson.room}` : '',
          lesson?.date,
          lesson?.startTime && lesson?.endTime ? `${lesson.startTime}–${lesson.endTime}` : lesson?.startTime
        ].filter(Boolean).join(' · ')}
      </p>

      {/* Lesson ended notification banner */}
      {isEnded && (
        <div className="banner" style={{ background: '#4d2020', border: '1px solid #ff767566', color: '#ffc5c5', padding: '14px 18px', borderRadius: 20, marginBottom: 16 }}>
          <div>
            <b style={{ color: '#fff' }}>⚠️ Занятие завершено</b>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#ffd2d2' }}>
              Пара закончилась в {lesson?.endTime || ''}. Очередь на эту пару закрыта и сброшена.
            </p>
          </div>
        </div>
      )}

      {/* Summary statistics */}
      <div className="queue-summary-banner">
        <div>
          <b>{activeMembers.length}</b>
          <span>В очереди</span>
        </div>
        <div>
          <b>{servingMember ? servingMember.name.split(' ')[0] : '—'}</b>
          <span>На защите</span>
        </div>
        <div>
          <b>~{activeMembers.length * 5} мин</b>
          <span>Ожидание</span>
        </div>
      </div>

      {/* Current student card */}
      {isUserInQueue && queue ? (
        <div className={'queue-main ' + queue.status}>
          <p>{statusCopy[queue.status] || 'Вы в очереди'}</p>
          <strong>№{queue.number}</strong>
          <div className="queue-stats">
            <span>
              <b>{queue.peopleAhead}</b>
              перед вами
            </span>
            <span>
              <b>~{queue.estimatedWaitMinutes} мин</b>
              ожидание
            </span>
          </div>
          <div style={{ marginTop: 20 }}>
            {confirmLeave ? (
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                <button
                  style={{
                    background: '#d63031',
                    color: '#fff',
                    padding: '10px 18px',
                    borderRadius: 14,
                    fontSize: 13,
                    fontWeight: 800
                  }}
                  onClick={async () => {
                    setConfirmLeave(false)
                    await onLeave()
                  }}
                >
                  Да, выйти из очереди
                </button>
                <button
                  className="secondary"
                  style={{ padding: '10px 18px', borderRadius: 14, fontSize: 13 }}
                  onClick={() => setConfirmLeave(false)}
                >
                  Отмена
                </button>
              </div>
            ) : (
              <button className="secondary" onClick={() => setConfirmLeave(true)}>
                Покинуть очередь
              </button>
            )}
          </div>
        </div>
      ) : isEnded ? (
        <div className="detail-card" style={{ textAlign: 'center', padding: '20px 16px' }}>
          <p style={{ border: 0, justifyContent: 'center', fontSize: 16, color: '#f1f8ff', fontWeight: 700 }}>
            Пара завершена
          </p>
          <p style={{ border: 0, justifyContent: 'center', marginTop: -8 }}>
            Время занятия истекло ({lesson?.startTime}–{lesson?.endTime}). Очередь сброшена.
          </p>
        </div>
      ) : (
        <div className="detail-card" style={{ textAlign: 'center', padding: '20px 16px' }}>
          <p style={{ border: 0, justifyContent: 'center', fontSize: 16, color: '#f1f8ff', fontWeight: 700 }}>
            Вы пока не в очереди
          </p>
          <p style={{ border: 0, justifyContent: 'center', marginTop: -8 }}>
            Нажмите кнопку ниже, чтобы занять очередь со своим именем ({user.name}).
          </p>
          <button onClick={onJoin} style={{ width: '100%', marginTop: 8 }}>
            Встать в очередь по ОАиП
          </button>
        </div>
      )}

      {/* Full list of students: showing place and name of each student */}
      <div className="section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2>Студенты в очереди ({activeMembers.length})</h2>
          <span className="muted">Имя и место каждого · автообновление</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {onRefresh && (
            <button
              className="secondary"
              onClick={handleManualRefresh}
              disabled={refreshing}
              style={{ padding: '6px 12px', fontSize: 13, borderRadius: 10 }}
            >
              {refreshing ? 'Обновление...' : '↻ Обновить'}
            </button>
          )}
          {onReset && (
            confirmReset ? (
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  style={{
                    background: '#d63031',
                    color: '#fff',
                    padding: '6px 10px',
                    fontSize: 12,
                    borderRadius: 10,
                    fontWeight: 700
                  }}
                  onClick={async () => {
                    setConfirmReset(false)
                    await onReset()
                  }}
                >
                  Сбросить
                </button>
                <button
                  className="secondary"
                  style={{ padding: '6px 8px', fontSize: 12, borderRadius: 10 }}
                  onClick={() => setConfirmReset(false)}
                >
                  ×
                </button>
              </div>
            ) : (
              <button
                className="secondary"
                onClick={() => setConfirmReset(true)}
                style={{ padding: '6px 10px', fontSize: 13, borderRadius: 10, color: '#ffafc0' }}
                title="Сбросить очередь лабораторной"
              >
                Сброс
              </button>
            )
          )}
        </div>
      </div>

      <div className="queue-members-list">
        {!isEnded && members.map(member => {
          const isCurrent =
            member.isCurrentUser ||
            (user.name && member.name.toLowerCase() === user.name.toLowerCase())
          const isServing = member.status === 'serving'

          return (
            <div
              key={member.id}
              className={`queue-member-card ${isCurrent ? 'is-current' : ''} ${
                isServing ? 'is-serving' : ''
              }`}
            >
              <div className="queue-member-left">
                <div className="queue-pos-badge">№{member.number}</div>
                <div className="queue-member-info">
                  <div className="queue-member-name-row">
                    <span className="queue-member-name">{member.name}</span>
                    {isCurrent && <span className="you-pill">Вы</span>}
                  </div>
                  <span className="queue-member-meta">
                    Группа: {member.group} · записан в {member.joinedAt}
                  </span>
                </div>
              </div>

              <div>
                <span className={`queue-tag ${member.status}`}>
                  {member.status === 'serving' && '🟢 На защите'}
                  {member.status === 'next' && '🟡 Следующий'}
                  {member.status === 'waiting' && '⏳ В очереди'}
                  {member.status === 'called' && '🔔 Вызывают'}
                  {member.status === 'completed' && '✓ Защитил'}
                </span>
              </div>
            </div>
          )
        })}

        {(isEnded || members.length === 0) && (
          <div className="hint">
            {isEnded ? 'Очередь сброшена по окончании пары.' : 'Очередь пуста. Будьте первым, кто запишется!'}
          </div>
        )}
      </div>
    </>
  )
}

function LessonDetails({
  lesson,
  queue,
  members,
  onJoin,
  onQueue
}: {
  lesson: Lesson
  queue: Queue | null
  members: QueueMember[]
  onJoin: () => void
  onQueue: () => void
}) {
  const activeCount = members.filter(m => m.status !== 'completed').length

  return (
    <>
      <p className="eyebrow">{lesson.lessonTypeAbbrev === 'ЛР' ? 'ЛАБОРАТОРНАЯ РАБОТА' : 'ЗАНЯТИЕ'}</p>
      <h1>{lesson.title}</h1>
      <p className="muted">
        {lesson.date} · {lesson.startTime}–{lesson.endTime}
      </p>

      <div className="detail-card">
        <p>
          Предмет <b>{lesson.subject || 'ОАиП'}</b>
        </p>
        {lesson.teacher && (
          <p>
            Преподаватель <b>{lesson.teacher}</b>
          </p>
        )}
        {lesson.room && (
          <p>
            Аудитория <b>{lesson.room}</b>
          </p>
        )}
        <p>
          Тип занятия <b>{lesson.lessonTypeAbbrev || 'Лабораторная'}</b>
        </p>
        <p>
          Подгруппа <b>{lesson.subgroup === 1 || lesson.subgroup === 2 ? `${lesson.subgroup} подгруппа` : 'Общая (вся группа)'}</b>
        </p>
        <p>
          Студентов в очереди <b>{activeCount} чел.</b>
        </p>
        {lesson.note && (
          <p>
            Примечание <b style={{ textAlign: 'right' }}>{lesson.note}</b>
          </p>
        )}
      </div>

      <div style={{ display: 'grid', gap: 12 }}>
        <button onClick={onQueue}>Открыть очередь ({activeCount} чел.)</button>

        {!queue && (
          <button className="secondary" onClick={onJoin}>
            Встать в очередь
          </button>
        )}
      </div>
    </>
  )
}

function ScheduleView({
  lessons,
  userSubgroup,
  onOpen,
  onOpenQueue
}: {
  lessons: Lesson[]
  userSubgroup: 1 | 2
  onOpen: (l: Lesson) => void
  onOpenQueue: (l: Lesson) => void
}) {
  const [subjectFilter, setSubjectFilter] = useState<'all' | 'oaip' | 'labs' | 'pz' | 'lk'>('all')
  const [periodFilter, setPeriodFilter] = useState<'upcoming' | 'week' | 'all'>('upcoming')
  const [searchQuery, setSearchQuery] = useState('')

  const now = new Date()
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

  // Week boundaries (Monday to Sunday)
  const dayOfWeek = (now.getDay() + 6) % 7 // Monday = 0
  const monday = new Date(now)
  monday.setDate(monday.getDate() - dayOfWeek)
  const mondayStr = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`

  const sunday = new Date(monday)
  sunday.setDate(sunday.getDate() + 6)
  const sundayStr = `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, '0')}-${String(sunday.getDate()).padStart(2, '0')}`

  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`

  // 0. Filter by user's selected subgroup (shows common lessons + user's subgroup)
  const subgroupLessons = lessons.filter(l => isLessonForSubgroup(l, userSubgroup))

  // 1. Filter by subject and search query
  let filtered = subgroupLessons.filter(l => {
    const isOaip = l.subject?.toLowerCase().includes('оаип') || l.title?.toLowerCase().includes('оаип')
    const isLab = l.lessonTypeAbbrev === 'ЛР' || l.lessonTypeAbbrev === 'Лаб'
    const isPz = l.lessonTypeAbbrev === 'ПЗ'
    const isLk = l.lessonTypeAbbrev === 'ЛК'

    if (subjectFilter === 'oaip' && !isOaip) return false
    if (subjectFilter === 'labs' && !isLab) return false
    if (subjectFilter === 'pz' && !isPz) return false
    if (subjectFilter === 'lk' && !isLk) return false

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      const match =
        (l.subject && l.subject.toLowerCase().includes(q)) ||
        (l.title && l.title.toLowerCase().includes(q)) ||
        (l.teacher && l.teacher.toLowerCase().includes(q)) ||
        (l.room && l.room.toLowerCase().includes(q))
      if (!match) return false
    }

    return true
  })

  // 2. Filter by period
  if (periodFilter === 'upcoming') {
    const upcoming = filtered.filter(l => l.date >= todayStr)
    if (upcoming.length > 0) {
      filtered = upcoming
    }
  } else if (periodFilter === 'week') {
    const onWeek = filtered.filter(l => l.date >= mondayStr && l.date <= sundayStr)
    if (onWeek.length > 0) {
      filtered = onWeek
    }
  }

  // 3. Group chronologically by date
  const dayGroupsMap = new Map<string, Lesson[]>()
  filtered.forEach(l => {
    const list = dayGroupsMap.get(l.date) || []
    list.push(l)
    dayGroupsMap.set(l.date, list)
  })

  const sortedDates = Array.from(dayGroupsMap.keys()).sort((a, b) => a.localeCompare(b))

  const russianMonths = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
  ]
  const russianWeekdays = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота']

  const getDayInfo = (dateStr: string) => {
    const parts = dateStr.split('-')
    if (parts.length === 3) {
      const y = Number(parts[0])
      const m = Number(parts[1]) - 1
      const d = Number(parts[2])
      const dt = new Date(y, m, d, 12, 0, 0)
      const weekday = russianWeekdays[dt.getDay()]
      const displayDate = `${d} ${russianMonths[m]}`
      return { weekday, displayDate }
    }
    return { weekday: 'День', displayDate: dateStr }
  }

  const getLessonTypeClass = (abbrev?: string) => {
    if (!abbrev) return 'default'
    const clean = abbrev.toUpperCase()
    if (clean === 'ЛР' || clean === 'ЛАБ') return 'lr'
    if (clean === 'ПЗ') return 'pz'
    if (clean === 'ЛК') return 'lk'
    return 'default'
  }

  return (
    <>
      <p className="eyebrow">РАСПИСАНИЕ ЗАНЯТИЙ · {userSubgroup} ПОДГРУППА</p>
      <h1>Расписание группы</h1>
      <p className="muted">
        Только занятия для {userSubgroup}-й подгруппы и общие пары · Всего {subgroupLessons.length} занятий
      </p>

      <div className="schedule-controls">
        <input
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Поиск по предмету, преподавателю, аудитории..."
          style={{
            padding: '12px 16px',
            borderRadius: 14,
            background: '#071a3a',
            border: '1px solid #3b628b',
            color: '#e7f4ff',
            fontSize: 13,
            outline: 'none',
            width: '100%'
          }}
        />

        <div className="schedule-filters-row">
          <button
            className={`schedule-filter-btn ${periodFilter === 'upcoming' ? '' : 'secondary'}`}
            onClick={() => setPeriodFilter('upcoming')}
          >
            Ближайшие дни
          </button>
          <button
            className={`schedule-filter-btn ${periodFilter === 'week' ? '' : 'secondary'}`}
            onClick={() => setPeriodFilter('week')}
          >
            Текущая неделя
          </button>
          <button
            className={`schedule-filter-btn ${periodFilter === 'all' ? '' : 'secondary'}`}
            onClick={() => setPeriodFilter('all')}
          >
            Все дни семестра
          </button>
        </div>

        <div className="schedule-filters-row">
          <button
            className={`schedule-filter-btn ${subjectFilter === 'all' ? '' : 'secondary'}`}
            onClick={() => setSubjectFilter('all')}
          >
            Все предметы
          </button>
          <button
            className={`schedule-filter-btn ${subjectFilter === 'oaip' ? '' : 'secondary'}`}
            onClick={() => setSubjectFilter('oaip')}
          >
            ОАиП
          </button>
          <button
            className={`schedule-filter-btn ${subjectFilter === 'labs' ? '' : 'secondary'}`}
            onClick={() => setSubjectFilter('labs')}
          >
            Лабораторные (ЛР)
          </button>
          <button
            className={`schedule-filter-btn ${subjectFilter === 'pz' ? '' : 'secondary'}`}
            onClick={() => setSubjectFilter('pz')}
          >
            Практика (ПЗ)
          </button>
          <button
            className={`schedule-filter-btn ${subjectFilter === 'lk' ? '' : 'secondary'}`}
            onClick={() => setSubjectFilter('lk')}
          >
            Лекции (ЛК)
          </button>
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        {sortedDates.map(dateStr => {
          const dayLessons = dayGroupsMap.get(dateStr) || []
          const { weekday, displayDate } = getDayInfo(dateStr)
          const isToday = dateStr === todayStr
          const isTomorrow = dateStr === tomorrowStr

          return (
            <div
              key={dateStr}
              className={`schedule-day-group ${isToday ? 'is-today-group' : ''}`}
            >
              <div className="schedule-day-header">
                <div className="schedule-day-title-wrap">
                  <span className="schedule-day-name">{weekday}</span>
                  <span className="schedule-day-date">{displayDate}</span>
                </div>
                <div className="schedule-day-badges">
                  {isToday && <span className="day-badge today">Сегодня</span>}
                  {isTomorrow && <span className="day-badge tomorrow">Завтра</span>}
                  <span className="day-badge count">
                    {dayLessons.length} {dayLessons.length === 1 ? 'пара' : dayLessons.length < 5 ? 'пары' : 'пар'}
                  </span>
                </div>
              </div>

              <div className="schedule-day-lessons">
                {dayLessons.map(l => {
                  const isOaip = l.subject?.toLowerCase().includes('оаип') || l.title?.toLowerCase().includes('оаип')
                  const typeClass = getLessonTypeClass(l.lessonTypeAbbrev)

                  return (
                    <div
                      key={l.id}
                      className={`schedule-lesson-row ${isOaip ? 'is-oaip-row' : ''}`}
                    >
                      <div
                        className="schedule-lesson-left"
                        style={{ cursor: 'pointer' }}
                        onClick={() => onOpen(l)}
                      >
                        <div className="schedule-time-box">
                          <span className="schedule-time-start">{l.startTime}</span>
                          {l.endTime && <span className="schedule-time-end">{l.endTime}</span>}
                        </div>

                        <div className="schedule-lesson-info">
                          <div className="schedule-lesson-subject-row">
                            <span className="schedule-lesson-subject">{l.subject || 'Занятие'}</span>
                            <span className={`lesson-type-pill ${typeClass}`}>
                              {l.lessonTypeAbbrev || 'Занятие'}
                            </span>
                            {(l.subgroup === 1 || l.subgroup === 2) && (
                              <span className={`lesson-subgroup-pill sg-${l.subgroup}`}>
                                {l.subgroup} подгруппа
                              </span>
                            )}
                          </div>

                          {l.title && l.title !== l.subject && (
                            <span className="schedule-lesson-title">{l.title}</span>
                          )}

                          <span className="schedule-lesson-meta">
                            {[l.teacher, l.room ? `Ауд. ${l.room}` : ''].filter(Boolean).join(' · ')}
                          </span>
                        </div>
                      </div>

                      <div className="schedule-lesson-actions">
                        {isOaip && (
                          <button
                            className="schedule-btn-queue"
                            onClick={() => onOpenQueue(l)}
                          >
                            Очередь
                          </button>
                        )}
                        <button
                          className="secondary schedule-btn-info"
                          onClick={() => onOpen(l)}
                        >
                          Инфо
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}

        {sortedDates.length === 0 && (
          <div className="hint" style={{ textAlign: 'center', padding: '30px 20px' }}>
            <p style={{ fontWeight: 700, fontSize: 16, color: '#f1f8ff', margin: '0 0 6px' }}>
              Занятий не найдено
            </p>
            <p style={{ margin: 0, fontSize: 13, color: '#92b5d6' }}>
              Попробуйте выбрать другой фильтр или переключить на «Все дни семестра»
            </p>
          </div>
        )}
      </div>
    </>
  )
}

function Profile({
  user,
  onChangeSubgroup,
  onToggle,
  onHistory,
  onLogout
}: {
  user: User
  onChangeSubgroup: (sg: 1 | 2) => void
  onToggle: () => void
  onHistory: () => void
  onLogout: () => void
}) {
  const currentSubgroup = user.subgroup === 2 ? 2 : 1

  return (
    <>
      <p className="eyebrow">ЛИЧНЫЙ КАБИНЕТ</p>
      <h1>Профиль студента</h1>
      <div className="profile-card">
        <p>
          Имя и фамилия <b>{user.name}</b>
        </p>
        <p>
          Студенческая группа <b>{user.group}</b>
        </p>
        <p>
          Подгруппа <b>{currentSubgroup} подгруппа</b>
        </p>
        <p>
          Предмет <b>ОАиП</b>
        </p>
      </div>

      <div className="subgroup-switch-card">
        <div className="subgroup-switch-header">
          <div>
            <b>Выбор подгруппы</b>
            <small>Показывать в расписании и очереди только занятия вашей подгруппы</small>
          </div>
        </div>
        <div className="subgroup-segmented">
          <button
            type="button"
            className={`subgroup-seg-btn ${currentSubgroup === 1 ? 'active' : ''}`}
            onClick={() => onChangeSubgroup(1)}
          >
            1 подгруппа
          </button>
          <button
            type="button"
            className={`subgroup-seg-btn ${currentSubgroup === 2 ? 'active' : ''}`}
            onClick={() => onChangeSubgroup(2)}
          >
            2 подгруппа
          </button>
        </div>
      </div>

      <button className="list-card" onClick={onToggle}>
        <span>
          <b>Уведомления о вызове</b>
          <small>Оповещать, когда подходит моя очередь</small>
        </span>
        <span className="toggle">{user.notifications ? 'Вкл.' : 'Выкл.'}</span>
      </button>

      <button className="list-card" onClick={onHistory}>
        <span>
          <b>История сданных лабораторных</b>
          <small>Предыдущие защиты по ОАиП</small>
        </span>
        <span>→</span>
      </button>

      <button
        className="secondary"
        style={{ width: '100%', marginTop: 24, padding: 14 }}
        onClick={onLogout}
      >
        Сменить пользователя / Выйти
      </button>
    </>
  )
}

function History() {
  return (
    <>
      <p className="eyebrow">АРХИВ СДАЧ</p>
      <h1>История лабораторных</h1>
      <div className="list">
        <div className="history-item">
          <b>ОАиП (Основы алгоритмизации и программирования)</b>
          <p>Лабораторная работа</p>
          <small>ОАиП · Сдано преподавателю</small>
          <span className="tag completed">Сдано</span>
        </div>
      </div>
    </>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
