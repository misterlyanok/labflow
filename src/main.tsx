import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api, usingRemoteApi } from './api'
import type { Lesson, Queue, QueueMember, Screen, User } from './types'
import './styles.css'

const statusCopy: Record<string, string> = {
  waiting: 'В очереди',
  next: 'Вы следующий',
  called: 'Вас вызывают',
  serving: 'На защите',
  completed: 'Сдал работу'
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

      // Find the primary OAIP lesson (prefer lab work ЛР)
      const oaipLabs = schedule.filter(
        l =>
          (l.subject?.toLowerCase().includes('оаип') || l.title?.toLowerCase().includes('оаип')) &&
          (l.lessonTypeAbbrev === 'ЛР' || l.lessonTypeAbbrev === 'Лаб')
      )
      const targetOaip =
        oaipLabs[0] ||
        schedule.find(l => l.subject?.toLowerCase().includes('оаип') || l.title?.toLowerCase().includes('оаип')) ||
        schedule[0]

      if (targetOaip) {
        setLesson(targetOaip)
        const [activeQueue, members] = await Promise.all([
          api.getQueue(currentUser, targetOaip.id),
          api.getQueueMembers(targetOaip.id)
        ])
        setQueue(activeQueue)
        setQueueMembers(members)
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
      const [q, members] = await Promise.all([
        api.getQueue(user, currentLesson.id),
        api.getQueueMembers(currentLesson.id)
      ])
      setQueue(q)
      setQueueMembers(members)
      setScreen('queue')
    } finally {
      setLoading(false)
    }
  }

  const joinQueue = async () => {
    if (!user) return
    const currentLesson = lesson || lessons[0]
    if (!currentLesson) return
    setLoading(true)
    try {
      const q = await api.joinQueue(currentLesson.id, user)
      const members = await api.getQueueMembers(currentLesson.id)
      setQueue(q)
      setQueueMembers(members)
      setScreen('queue')
    } finally {
      setLoading(false)
    }
  }

  const leaveQueue = async () => {
    if (!user) return
    if (confirm('Покинуть очередь по ОАиП? Вы освободите своё место.')) {
      setLoading(true)
      try {
        const currentLessonId = lesson?.id || ''
        await api.leaveQueue(user, queue?.id, currentLessonId)
        setQueue(null)
        const members = await api.getQueueMembers(currentLessonId)
        setQueueMembers(members)
      } finally {
        setLoading(false)
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
                  const oaip = lessons.find(
                    l =>
                      (l.subject?.toLowerCase().includes('оаип') || l.title?.toLowerCase().includes('оаип')) &&
                      (l.lessonTypeAbbrev === 'ЛР' || l.lessonTypeAbbrev === 'Лаб')
                  ) || lessons.find(l => l.subject?.toLowerCase().includes('оаип')) || lessons[0]
                  openQueue(oaip)
                }}
                onOpenLesson={openLesson}
              />
            )}

            {screen === 'schedule' && (
              <ScheduleView
                lessons={lessons}
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
              />
            )}

            {screen === 'profile' && (
              <Profile
                user={user}
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
            const oaip = lessons.find(
              l =>
                (l.subject?.toLowerCase().includes('оаип') || l.title?.toLowerCase().includes('оаип')) &&
                (l.lessonTypeAbbrev === 'ЛР' || l.lessonTypeAbbrev === 'Лаб')
            ) || lessons.find(l => l.subject?.toLowerCase().includes('оаип')) || lessons[0]
            openQueue(oaip)
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
  const oaipLesson =
    lessons.find(
      l =>
        (l.subject?.toLowerCase().includes('оаип') || l.title?.toLowerCase().includes('оаип')) &&
        (l.lessonTypeAbbrev === 'ЛР' || l.lessonTypeAbbrev === 'Лаб')
    ) ||
    lessons.find(l => l.subject?.toLowerCase().includes('оаип') || l.title?.toLowerCase().includes('оаип')) ||
    lessons[0]

  return (
    <>
      <section className="hero">
        <p className="eyebrow">ПРЕДМЕТ ОАиП</p>
        <h1>Привет, {user.name} 👋</h1>
        <p className="muted">Группа: {user.group} · Основы алгоритмизации и программирования</p>
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
        <span className="muted">ОАиП</span>
      </div>

      {oaipLesson ? (
        <button className="lesson-card lab-highlight" onClick={() => onOpenLesson(oaipLesson)}>
          <div>
            <h3>{oaipLesson.subject || 'ОАиП'}</h3>
            <p>{oaipLesson.title}</p>
            {oaipLesson.teacher && <small style={{ color: '#8ec8ee' }}>{oaipLesson.teacher}</small>}
            {oaipLesson.room && <small style={{ color: '#68a1c9', display: 'block' }}>Аудитория: {oaipLesson.room}</small>}
            <em className="lesson-kind">{oaipLesson.lessonTypeAbbrev || 'Лабораторная'}</em>
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
  onLeave
}: {
  queue: Queue | null
  lesson: Lesson | null
  user: User
  members: QueueMember[]
  onJoin: () => void
  onLeave: () => void
}) {
  const activeMembers = members.filter(m => m.status !== 'completed')
  const servingMember = members.find(m => m.status === 'serving')
  const isUserInQueue = Boolean(queue)

  return (
    <>
      <p className="eyebrow">ЭЛЕКТРОННАЯ ОЧЕРЕДЬ · ОАиП</p>
      <h1>{lesson?.title || 'Лабораторная работа по ОАиП'}</h1>
      <p className="muted">
        {[lesson?.teacher, lesson?.room, lesson?.date, lesson?.startTime].filter(Boolean).join(' · ')}
      </p>

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
            <button className="secondary" onClick={onLeave}>
              Покинуть очередь
            </button>
          </div>
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
      <div className="section-title">
        <h2>Студенты в очереди ({activeMembers.length})</h2>
        <span className="muted">Имя и место каждого</span>
      </div>

      <div className="queue-members-list">
        {members.map(member => {
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

        {members.length === 0 && (
          <div className="hint">Очередь пуста. Будьте первым, кто запишется!</div>
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
  onOpen,
  onOpenQueue
}: {
  lessons: Lesson[]
  onOpen: (l: Lesson) => void
  onOpenQueue: (l: Lesson) => void
}) {
  const [filterOaip, setFilterOaip] = useState(false)

  const filtered = filterOaip
    ? lessons.filter(l => l.subject?.toLowerCase().includes('оаип') || l.title?.toLowerCase().includes('оаип'))
    : lessons

  return (
    <>
      <p className="eyebrow">РАСПИСАНИЕ ЗАНЯТИЙ</p>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Расписание группы</h1>
        <button
          className={filterOaip ? '' : 'secondary'}
          style={{ padding: '6px 14px', fontSize: 13, borderRadius: 12 }}
          onClick={() => setFilterOaip(!filterOaip)}
        >
          {filterOaip ? 'Все предметы' : 'Только ОАиП'}
        </button>
      </div>
      <p className="muted">
        Расписание получено из университетского API BSUIR ({lessons.length} занятий)
      </p>

      <div className="list">
        {filtered.slice(0, 50).map(l => {
          const isOaip = l.subject?.toLowerCase().includes('оаип') || l.title?.toLowerCase().includes('оаип')
          return (
            <div
              key={l.id}
              className={`list-card ${isOaip ? 'lab-highlight' : ''}`}
              style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
            >
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%', cursor: 'pointer' }}
                onClick={() => onOpen(l)}
              >
                <div>
                  <b>{l.subject || 'Занятие'}</b>
                  <small style={{ color: '#d2ebff' }}>{l.title}</small>
                  {l.teacher && <small style={{ color: '#88afce', marginTop: 3 }}>{l.teacher}</small>}
                  {l.room && <small style={{ color: '#6693b8' }}>Аудитория: {l.room}</small>}
                  <em className="lesson-kind">{l.lessonTypeAbbrev || 'Занятие'}</em>
                </div>
                <time style={{ textAlign: 'right', minWidth: 80 }}>
                  <span style={{ fontSize: 13, color: '#92b7d8' }}>{l.date}</span>
                  <b style={{ display: 'block', fontSize: 17, color: '#7ee8ff' }}>{l.startTime}</b>
                </time>
              </div>

              <div style={{ display: 'flex', gap: 8, width: '100%', borderTop: '1px solid #3c6e9a44', paddingTop: 10 }}>
                {isOaip && (
                  <button
                    style={{ flex: 1, padding: '8px 12px', fontSize: 13, borderRadius: 10 }}
                    onClick={() => onOpenQueue(l)}
                  >
                    Очередь
                  </button>
                )}
                <button
                  className="secondary"
                  style={{ flex: 1, padding: '8px 12px', fontSize: 13, borderRadius: 10 }}
                  onClick={() => onOpen(l)}
                >
                  Подробнее
                </button>
              </div>
            </div>
          )
        })}

        {filtered.length === 0 && (
          <div className="hint">Занятий не найдено.</div>
        )}
      </div>
    </>
  )
}

function Profile({
  user,
  onToggle,
  onHistory,
  onLogout
}: {
  user: User
  onToggle: () => void
  onHistory: () => void
  onLogout: () => void
}) {
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
          Предмет <b>ОАиП</b>
        </p>
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
