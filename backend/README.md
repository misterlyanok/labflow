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

Если на backend задана переменная `DATABASE_URL`, при запуске автоматически создаются таблицы `users`, `sessions` и `queue_entries`, а очередь сохраняется в PostgreSQL после перезапуска. Без этой переменной локально остаётся режим памяти для разработки.

В Render добавь `DATABASE_URL` со значением Internal Database URL из раздела Connect созданной базы PostgreSQL. Переменная нужна только backend-сервису.

## Университетское расписание

Задай на backend переменную `UNIVERSITY_SCHEDULE_URL`. Для БГУИР используй `https://iis.bsuir.by/api/v1/schedule?studentGroup={groupNumber}`. При запросе `GET /schedule` сервер подставит группу текущего пользователя вместо `{groupNumber}`, выполнит HTTP GET с `Accept: application/json`, преобразует ответ и вернёт frontend единый формат. Поддерживаются ответы-массивы и объекты с полями `lessons`, `schedule` или `data`.

Если переменная не задана, используется локальная mock-заглушка.
