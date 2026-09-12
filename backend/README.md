# LabFlow API MVP

Локальный backend для mock-расписания и общей очереди.

## Запуск

```bash
npm run server
```

Сервер запускается на `http://localhost:8787`. Для деплоя используется Node.js 22 LTS.

## Что реализовано

- `POST /auth/login` — тестовая авторизация для группы `668204` и пароля `hedge67`;
- `GET /me`, `PATCH /me` — профиль;
- `GET /schedule` — заглушка расписания университета;
- `GET /lessons/:id` — детали лабораторной;
- `GET /me/queue` — текущая очередь пользователя;
- `POST /lessons/:id/queue/join` — встать в очередь;
- `DELETE /queues/:id/leave` — выйти из очереди;
- `GET /me/history` — история.

Сейчас данные хранятся в памяти процесса. После перезапуска сервера они сбрасываются. Следующий шаг — заменить коллекции в `server.mjs` на PostgreSQL/Prisma.
