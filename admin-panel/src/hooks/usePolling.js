import { useEffect, useRef, useState, useCallback } from 'react'

// Polls a real API call on an interval and exposes { data, error, loading,
// refresh }. No cached/fake data between requests - a failed poll just
// surfaces `error` and keeps whatever the last successful response was.
export default function usePolling(fetcher, intervalMs = 5000, deps = []) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const refresh = useCallback(async () => {
    try {
      const result = await fetcherRef.current()
      setData(result)
      setError(null)
    } catch (err) {
      setError(err.message || 'Request failed')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer

    const tick = async () => {
      if (cancelled) return
      await refresh()
      if (!cancelled) timer = setTimeout(tick, intervalMs)
    }
    tick()

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { data, error, loading, refresh }
}
