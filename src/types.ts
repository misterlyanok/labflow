export type QueueStatus = 'waiting' | 'next' | 'called' | 'serving' | 'completed'
export type RegistrationStatus = 'open' | 'not_open' | 'full' | 'closed' | 'completed'
export type Screen = 'home' | 'subjects' | 'profile' | 'history' | 'schedule' | 'lesson' | 'queue'
export interface Subject { id: string; name: string; labCount: number }
export interface Lesson { id: string; subjectId: string; title: string; date: string; startTime: string; endTime: string; teacher?: string; room?: string; registration: RegistrationStatus }
export interface Queue { id: string; lessonId: string; number: number; peopleAhead: number; estimatedWaitMinutes: number; status: QueueStatus; joinedAt: string }
export interface User { name: string; group: string; notifications: boolean }
