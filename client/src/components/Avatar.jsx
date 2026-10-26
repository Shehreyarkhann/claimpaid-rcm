import { useEffect, useState } from 'react';
import { authFetch } from '../auth';

// Avatar photos are served behind Bearer auth, so an <img src> can't load
// them directly — fetch the blob once per user and cache the object URL.
const cache = new Map(); // userId -> objectUrl | 'none'
const listeners = new Set();
export function bustAvatar(userId) {
  const cur = cache.get(userId);
  if (cur && cur !== 'none') URL.revokeObjectURL(cur);
  cache.delete(userId);
  listeners.forEach((fn) => fn());
}

export default function Avatar({ userId, name, hasAvatar, className = 'w-9 h-9 text-xs', textClass = '' }) {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((x) => x + 1);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  const [url, setUrl] = useState(() => (hasAvatar && cache.get(userId)) || null);

  useEffect(() => {
    if (!hasAvatar || !userId) { setUrl(null); return; }
    const cached = cache.get(userId);
    if (cached && cached !== 'none') { setUrl(cached); return; }
    if (cached === 'none') { setUrl(null); return; }
    let dead = false;
    authFetch(`/api/auth/avatar/${userId}`)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('no avatar'))))
      .then((blob) => {
        const objUrl = URL.createObjectURL(blob);
        cache.set(userId, objUrl);
        if (!dead) setUrl(objUrl);
      })
      .catch(() => { cache.set(userId, 'none'); if (!dead) setUrl(null); });
    return () => { dead = true; };
  }, [userId, hasAvatar]);

  const initials = (name || '?').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  if (url) return <img src={url} alt={name || 'Profile photo'} className={`${className} rounded-full object-cover shrink-0`} />;
  return (
    <div className={`${className} rounded-full bg-gradient-to-br from-emerald-400 to-sky-500 flex items-center justify-center font-bold text-white shrink-0 ${textClass}`}>
      {initials}
    </div>
  );
}
