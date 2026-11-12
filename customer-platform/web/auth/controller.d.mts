import type { AuthMe, CustomerApi, PublicConfig } from '../api.mjs';
export interface AuthState {
  phase: 'checking' | 'email' | 'code' | 'authenticated';
  email: string;
  code: string;
  error: { code: string; message: string; field?: 'email' | 'code' } | null;
  busy: 'bootstrap' | 'request' | 'resend' | 'verify' | 'session' | 'logout' | null;
  resendAt: number;
  remainingSeconds: number;
  me: AuthMe | null;
  config: PublicConfig | null;
  status: string;
}
export interface AuthController {
  readonly state: AuthState;
  subscribe(listener: (state: AuthState) => void): () => void;
  bootstrap(): Promise<boolean>;
  setEmail(email: string): void;
  setCode(code: string): void;
  requestCode(): Promise<boolean>;
  resendCode(): Promise<boolean>;
  verifyCode(): Promise<boolean>;
  changeEmail(): void;
  checkSession(): Promise<boolean>;
  logout(): Promise<boolean>;
  destroy(): void;
}
export function createAuthController(api: CustomerApi, options?: { now?: () => number }): AuthController;
