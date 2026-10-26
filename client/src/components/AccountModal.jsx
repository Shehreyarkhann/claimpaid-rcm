import { useEffect, useRef, useState } from 'react';
import { Modal, useToast } from './ui';
import Avatar, { bustAvatar } from './Avatar';
import { api } from '../api';
import { useAuth } from '../auth';

// Downscale + square-crop an image file to a 256px JPEG data URL (~20-40 KB).
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const size = 256;
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const ctx = c.getContext('2d');
      const side = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
    img.src = url;
  });
}

export default function AccountModal({ initialTab = 'profile', onClose }) {
  const { user, refreshMe, adoptToken, logout } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState(initialTab);
  const [form, setForm] = useState({ name: '', title: '', phone: '' });
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [busy, setBusy] = useState('');
  const [confirmAll, setConfirmAll] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    if (user) setForm({ name: user.name || '', title: user.title || '', phone: user.phone || '' });
  }, [user]);

  if (!user) return null;
  const isGoogle = user.auth_provider === 'google';

  const uploadPhoto = async (file) => {
    if (!file) return;
    setBusy('photo');
    try {
      const dataUrl = await fileToDataUrl(file);
      await api.uploadAvatar(dataUrl);
      bustAvatar(user.id);
      await refreshMe();
      toast.success('Profile photo updated');
    } catch (e) { toast.error(e.message); }
    setBusy('');
  };

  const removePhoto = async () => {
    setBusy('photo');
    try {
      await api.deleteAvatar();
      bustAvatar(user.id);
      await refreshMe();
      toast.success('Profile photo removed');
    } catch (e) { toast.error(e.message); }
    setBusy('');
  };

  const saveProfile = async () => {
    setBusy('profile');
    try {
      await api.updateMe({ name: form.name, title: form.title, phone: form.phone });
      await refreshMe();
      toast.success('Profile saved');
    } catch (e) { toast.error(e.message); }
    setBusy('');
  };

  const changePassword = async () => {
    if (pw.next !== pw.confirm) { toast.error('New passwords do not match.'); return; }
    setBusy('pw');
    try {
      const r = await api.changePassword(pw.current, pw.next);
      adoptToken(r.token);
      setPw({ current: '', next: '', confirm: '' });
      toast.success('Password changed — other devices have been signed out');
    } catch (e) { toast.error(e.message); }
    setBusy('');
  };

  const logoutEverywhere = async () => {
    setBusy('all');
    try {
      const r = await api.logoutAll();
      adoptToken(r.token);
      setConfirmAll(false);
      toast.success('Signed out on all other devices');
    } catch (e) { toast.error(e.message); }
    setBusy('');
  };

  return (
    <Modal onClose={onClose}>
      <div className="p-5 sm:p-7">
        <div className="flex items-center gap-4 mb-5">
          <Avatar userId={user.id} name={user.name} hasAvatar={user.has_avatar} className="w-16 h-16 text-xl" />
          <div className="min-w-0">
            <div className="text-lg font-bold tracking-tight truncate">{user.name}</div>
            <div className="text-sm text-slate-500 truncate">{user.email}</div>
            <div className="text-xs text-slate-400 capitalize">{user.role} · {user.orgName || 'ClaimPaid'}</div>
          </div>
        </div>

        <div className="flex gap-1 bg-slate-100 rounded-xl p-1 mb-6">
          {[['profile', 'Profile'], ['security', 'Security']].map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition ${tab === id ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
              {label}
            </button>
          ))}
        </div>

        {tab === 'profile' && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <button className="btn btn-dark !text-sm" disabled={busy === 'photo'} onClick={() => fileRef.current?.click()}>
                {busy === 'photo' ? 'Uploading…' : 'Upload new photo'}
              </button>
              {user.has_avatar && (
                <button className="btn btn-ghost !text-sm !text-rose-600" disabled={busy === 'photo'} onClick={removePhoto}>Remove</button>
              )}
              <span className="text-xs text-slate-400">Square works best — we crop and resize automatically.</span>
              <input ref={fileRef} type="file" accept="image/*" className="hidden"
                onChange={(e) => { uploadPhoto(e.target.files?.[0]); e.target.value = ''; }} />
            </div>
            <div>
              <label className="label">Full name</label>
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={80} />
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="label">Job title</label>
                <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Billing Manager" maxLength={80} />
              </div>
              <div>
                <label className="label">Phone</label>
                <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="(555) 123-4567" maxLength={32} />
              </div>
            </div>
            <div>
              <label className="label">Email</label>
              <input className="input bg-slate-50" value={user.email} disabled />
              <p className="text-xs text-slate-400 mt-1">Email is your sign-in ID. To change it, contact support so we can verify the new address.</p>
            </div>
            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-slate-400">
                Member since {user.created_at ? new Date(String(user.created_at).replace(' ', 'T')).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '—'}
              </span>
              <button className="btn btn-primary !text-sm" disabled={busy === 'profile'} onClick={saveProfile}>
                {busy === 'profile' ? 'Saving…' : 'Save profile'}
              </button>
            </div>
          </div>
        )}

        {tab === 'security' && (
          <div className="space-y-5">
            {isGoogle ? (
              <div className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
                You sign in with Google, so there's no ClaimPaid password to change — manage it in your Google account.
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="label">Current password</label>
                  <input type="password" className="input" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" />
                </div>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label className="label">New password</label>
                    <input type="password" className="input" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" />
                  </div>
                  <div>
                    <label className="label">Confirm new password</label>
                    <input type="password" className="input" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} autoComplete="new-password" />
                  </div>
                </div>
                <p className="text-xs text-slate-400">At least 8 characters with an uppercase letter, a lowercase letter, a digit, and a symbol. Changing it signs out every other device.</p>
                <button className="btn btn-primary !text-sm" disabled={busy === 'pw' || !pw.current || !pw.next} onClick={changePassword}>
                  {busy === 'pw' ? 'Changing…' : 'Change password'}
                </button>
              </div>
            )}
            <div className="border-t border-slate-100 pt-4">
              <div className="font-medium text-sm mb-1">Sessions</div>
              <p className="text-xs text-slate-400 mb-3">Signed in somewhere you don't recognize, or on a shared computer? End every other session — this device stays signed in.</p>
              {confirmAll ? (
                <div className="flex gap-2 flex-wrap">
                  <button className="btn !bg-rose-600 hover:!bg-rose-700 !text-white !text-sm" disabled={busy === 'all'} onClick={logoutEverywhere}>
                    {busy === 'all' ? 'Signing out…' : 'Yes, sign out everywhere else'}
                  </button>
                  <button className="btn btn-ghost !text-sm" onClick={() => setConfirmAll(false)}>Cancel</button>
                </div>
              ) : (
                <div className="flex gap-2 flex-wrap">
                  <button className="btn btn-dark !text-sm" onClick={() => setConfirmAll(true)}>Log out of all other devices</button>
                  <button className="btn btn-ghost !text-sm !text-rose-600" onClick={() => { onClose(); logout(); }}>Log out of this device</button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
