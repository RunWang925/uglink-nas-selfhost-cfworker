import { AlertCircle, Eye, EyeOff, LoaderCircle, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { apiPost, ConsoleApiError } from '../lib/api';
import type { BootstrapResponse } from '../../../application/console/contracts';
import { Brand } from './Brand';

interface AuthGateProps {
  bootstrap: BootstrapResponse;
  onUnlocked: (response: BootstrapResponse) => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof ConsoleApiError) {
    return error.code === 'invalid_password' ? '访问密码错误，请重试。' : error.message;
  }
  return error instanceof Error ? error.message : '操作失败，请稍后重试。';
}

export function AuthGate({ bootstrap, onUnlocked }: AuthGateProps) {
  const isSetup = bootstrap.authState === 'needs_setup';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const tooShort = password.length > 0 && password.length < 6;
  const mismatch = isSetup && confirm.length > 0 && password !== confirm;
  const canSubmit = password.length >= 6 && (!isSetup || (confirm.length >= 6 && password === confirm)) && !busy;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(undefined);
    try {
      const endpoint = isSetup ? '/api/auth/setup' : '/api/auth/login';
      const response = await apiPost<BootstrapResponse>(endpoint, bootstrap.csrfToken, { password });
      onUnlocked(response);
    } catch (reason) {
      setError(errorMessage(reason));
      setPassword('');
      setConfirm('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <Brand />
      <form className="auth-card" onSubmit={submit}>
        <span className="auth-card__icon"><LockKeyhole size={24} /></span>
        <h1>{isSetup ? '设置控制台访问密码' : '输入访问密码'}</h1>
        <p className="auth-card__intro">
          {isSetup
            ? '首次使用需要设置一个访问密码。之后从这个网络打开控制台都需要输入，防止他人误改配置或查看凭据。'
            : '控制台已受密码保护，请输入访问密码继续。'}
        </p>

        <label className="auth-card__label" htmlFor="auth-password">
          {isSetup ? '新密码' : '访问密码'}
        </label>
        <div className="password-field">
          <input
            id="auth-password"
            type={visible ? 'text' : 'password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="至少 6 个字符"
            autoComplete={isSetup ? 'new-password' : 'current-password'}
            autoFocus
            disabled={busy}
          />
          <button
            className="password-field__toggle"
            type="button"
            onClick={() => setVisible((value) => !value)}
            aria-label={visible ? '隐藏密码' : '显示密码'}
            aria-pressed={visible}
            title={visible ? '隐藏密码' : '显示密码'}
          >
            {visible ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>

        {isSetup && (
          <>
            <label className="auth-card__label" htmlFor="auth-confirm">确认密码</label>
            <div className="password-field">
              <input
                id="auth-confirm"
                type={visible ? 'text' : 'password'}
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                placeholder="再次输入新密码"
                autoComplete="new-password"
                disabled={busy}
              />
            </div>
            {tooShort && <p className="auth-card__hint auth-card__hint--warn">密码至少需要 6 个字符。</p>}
            {mismatch && <p className="auth-card__hint auth-card__hint--warn">两次输入的密码不一致。</p>}
          </>
        )}

        {error && <p className="auth-card__error"><AlertCircle size={15} />{error}</p>}

        <button className="button button--primary auth-card__submit" type="submit" disabled={!canSubmit}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
          {isSetup ? '设置密码并进入' : '解锁并进入'}
        </button>

        {!isSetup && (
          <p className="auth-card__footnote">
            忘记密码？在部署配置中设置 <code>UGLINK_CONSOLE_PASSWORD</code> 环境变量并重启容器即可重置。
          </p>
        )}
      </form>
    </div>
  );
}
