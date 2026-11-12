const failure = () => ({status:'error', message:'로그인 링크를 확인하지 못했습니다. 요청한 브라우저에서 다시 로그인해 주세요.'});

// Callback secrets never leave this invocation except in the same-origin exchange body.
export async function completeEmailLink({location, history, fetchFn = globalThis.fetch}) {
  if (location.pathname !== '/auth/callback') return {status:'idle'};
  let fragment = location.hash;
  try {
    // Clear both fragment and query before parsing, fetching, or displaying anything.
    history.replaceState(null, '', '/auth/callback');
    if (typeof fragment !== 'string' || fragment.length > 12_000 || !fragment.startsWith('#')) return failure();
    const params = new URLSearchParams(fragment.slice(1));
    fragment = '';
    if (params.has('error') || params.has('error_code') || params.getAll('access_token').length !== 1
      || params.getAll('refresh_token').length !== 1) return failure();
    let accessToken = params.get('access_token');
    let refreshToken = params.get('refresh_token');
    // Discard the parsed URL fields before the exchange starts.
    for (const key of [...params.keys()]) params.delete(key);
    if (typeof accessToken !== 'string' || accessToken.length > 8192
      || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(accessToken)
      || typeof refreshToken !== 'string' || refreshToken.length < 8 || refreshToken.length > 512
      || !/^[A-Za-z0-9_-]+$/.test(refreshToken)) return failure();
    const body = JSON.stringify({accessToken, refreshToken});
    accessToken = null; refreshToken = null;
    const response = await fetchFn('/api/customer/auth/verify-link', {
      method:'POST', credentials:'same-origin', redirect:'error', cache:'no-store',
      headers:{'Content-Type':'application/json','X-TripMoney-Request':'1'}, body,
    });
    if (!response.ok) return failure();
    location.replace('/');
    return {status:'success'};
  } catch {
    return failure();
  } finally {
    fragment = '';
  }
}
