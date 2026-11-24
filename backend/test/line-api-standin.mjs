// E2E-only LINE API stand-in. Loaded with Node --import before the backend so browser
// tests never depend on api.line.me or use a real channel access token.
if (process.env.NODE_ENV !== 'test') {
  throw new Error('LINE API stand-in is restricted to NODE_ENV=test');
}

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith('https://api.line.me/')) return realFetch(input, init);

  if (url.includes('/member/')) {
    return Promise.resolve(Response.json({
      displayName: 'E2E LINE member',
      userId: 'U_test_user',
      pictureUrl: '',
      statusMessage: '',
    }));
  }

  return Promise.resolve(Response.json({ sentMessages: [] }));
};
