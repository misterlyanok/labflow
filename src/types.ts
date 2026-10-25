export type QueueStatus = 'waiting' | 'next' | 'called' | 'serving' | 'completed'
export type RegistrationStatus = 'open' | 'not_open' | 'full' | 'closed' | 'completed'
export type PriorityClass = 1 | 2 | 3
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
  subgroup?: number;
  registration: RegistrationStatus;
}
export interface QueueMember {
  id: string;
  userId?: string;
  position?: number;
  name: string;
  group: string;
  labNo?: number | null;
  priorityClass?: PriorityClass | null;
  status: QueueStatus;
  joinedAt: string;
  isCurrentUser?: boolean;
}
export interface Queue {
  id: string;
  lessonId: string;
  position?: number | null;
  labNo?: number | null;
  priorityClass?: PriorityClass | null;
  peopleAhead: number;
  estimatedWaitMinutes: number;
  status: QueueStatus;
  joinedAt: string;
  members: QueueMember[];
  completed?: QueueMember[];
  currentLabNo?: number | null;
}
export interface QueueView {
  members: QueueMember[];
  completed: QueueMember[];
  currentLabNo: number | null;
}
export interface User { id?: string; name: string; group: string; notifications: boolean; subgroup?: 1 | 2 }
