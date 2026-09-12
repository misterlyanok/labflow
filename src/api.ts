import type { Lesson, Queue, Subject, User } from './types'
const remoteBase = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const remoteToken = () => localStorage.getItem('labflow_token') || ''
async function remote<T>(path:string, options:RequestInit = {}):Promise<T>{
 const response = await fetch(`${remoteBase}${path}`, { ...options, headers:{'Content-Type':'application/json', ...(remoteToken()?{Authorization:`Bearer ${remoteToken()}`}:{}) , ...(options.headers||{})} })
 const data = await response.json().catch(()=>({}))
 if(!response.ok){const error = new Error(data.code || 'API_ERROR'); throw error}
 return data as T
}
const wait = (ms = 350) => new Promise(r => setTimeout(r, ms))
const subjects: Subject[] = [{id:'programming',name:'Programming',labCount:1}]
const lessons: Lesson[] = [
 {id:'p3',subjectId:'programming',title:'Laboratory #3',date:'Today',startTime:'14:30',endTime:'16:00',teacher:'A. Ivanov',room:'Lab 204',registration:'open'}
]
let currentQueue: Queue | null = null
let queueSize = 0
export const api = {
 async login(group:string,password:string): Promise<User> {
  if(remoteBase){const data=await remote<{user:User;token:string}>('/auth/login',{method:'POST',body:JSON.stringify({group:group.trim(),password})});localStorage.setItem('labflow_token',data.token);return data.user}
  await wait()
  if (group.trim() !== '668204' || password !== 'hedge67') throw new Error('INVALID_CREDENTIALS')
  return {name:'',group:group.trim(),notifications:true}
 },
 async saveName(name:string, user:User):Promise<User>{if(remoteBase){const data=await remote<{user:User}>('/me',{method:'PATCH',body:JSON.stringify({name})});return data.user} await wait(180); return {...user,name}},
 async getUser(){if(remoteBase){const data=await remote<{user:User}>('/me');return data.user} await wait(220); return {name:'',group:'',notifications:true}},
 async getSubjects(){await wait(); return subjects},
 async getUniversitySchedule(){if(remoteBase){const data=await remote<{lessons:Lesson[]}>('/schedule');return data.lessons} await wait(450); return lessons},
 async getLessons(subjectId:string){await wait(); return lessons.filter(l=>l.subjectId===subjectId)},
 async getLesson(id:string){if(remoteBase){const data=await remote<{lesson:Lesson}>(`/lessons/${id}`);return data.lesson} await wait(); return lessons.find(l=>l.id===id)!},
 async getQueue(){if(remoteBase){const data=await remote<{queue:Queue|null}>('/me/queue');return data.queue} await wait(180); return currentQueue},
 async joinQueue(lessonId:string){if(remoteBase){const data=await remote<{queue:Queue}>(`/lessons/${lessonId}/queue/join`,{method:'POST'});return data.queue} await wait(550); queueSize += 1; currentQueue={id:'q-new',lessonId,number:queueSize,peopleAhead:queueSize-1,estimatedWaitMinutes:Math.max(0,(queueSize-1)*5),status:'waiting',joinedAt:new Date().toISOString()}; return currentQueue},
 async leaveQueue(){if(remoteBase){const queue=await this.getQueue();if(queue) await remote(`/queues/${queue.id}/leave`,{method:'DELETE'});return} await wait(400); if(currentQueue){queueSize=Math.max(0,queueSize-1)} currentQueue=null},
 async history(){if(remoteBase){const data=await remote<{history:unknown[]}>('/me/history');return data.history} await wait(); return [{subject:'Programming',title:'Laboratory #2',date:'12 September · 14:30',number:4,status:'Completed'}]},
 async toggleNotifications(user:User){if(remoteBase){const data=await remote<{user:User}>('/me',{method:'PATCH',body:JSON.stringify({notifications:!user.notifications})});return data.user} await wait(150); return {...user,notifications:!user.notifications}}
}
