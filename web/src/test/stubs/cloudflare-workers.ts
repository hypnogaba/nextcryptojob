/**
 * Заглушка модуля `cloudflare:workers` для тестів у Node: його імпортує
 * @cloudflare/workers-oauth-provider, а в Node такої схеми немає. Тести беруть із бібліотеки лише
 * класи помилок, WorkerEntrypoint їм не потрібен.
 */
export class WorkerEntrypoint {}
