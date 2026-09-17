export type QueueStatus = 'waiting' | 'next' | 'called' | 'serving' | 'completed'
export type RegistrationStatus = 'open' | 'not_open' | 'full' | 'closed' | 'completed'
export type Screen = 'home' | 'subjects' | 'profile' | 'history' | 'schedule' | 'lesson' | 'queue'
export interface Subject { id: string; name: string; labCount: number }
export interface Lesson {
  id: string;
  subjectId: string;
  subject?: string;
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  teacher?: string;
  room?: string;
  note?: string;
  lessonTypeAbbrev?: string;
  registration: RegistrationStatus;
}
export interface QueueMember {
  id: string;
  userId?: string;
  number: number;
  name: string;
  group: string;
  status: QueueStatus;
  joinedAt: string;
  isCurrentUser?: boolean;
}
export interface Queue {
  id: string;
  lessonId: string;
  number: number;
  peopleAhead: number;
  estimatedWaitMinutes: number;
  status: QueueStatus;
  joinedAt: string;
  members: QueueMember[];
}
export interface User { name: string; group: string; notifications: boolean }
