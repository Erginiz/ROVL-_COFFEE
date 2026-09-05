// A lost Wi-Fi connection must release capture/UI resources on a bounded deadline.
export async function request(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController()
  const external = options.signal
  const abort = () => controller.abort()
  if (external?.aborted) abort()
  else external?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, timeoutMs)
  try { return await fetch(url, { ...options, signal: controller.signal }) }
  finally { clearTimeout(timer); external?.removeEventListener('abort', abort) }
}
