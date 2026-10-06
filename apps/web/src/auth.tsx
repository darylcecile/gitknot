import { useEffect, useState, type ReactNode } from "react";
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import { ArrowRight } from "lucide-react";
import {
  ApiError,
  request,
  setCsrfToken,
  setViewerGrant,
} from "./api/client.ts";
import { endpoints } from "./api/endpoints.ts";
import { authenticatePasskey } from "./api/webauthn.ts";
import { useMutation } from "./api/hooks.ts";
import { record, type Session, type User } from "./api/types.ts";
import { Button, ErrorNotice, Loading, Notice } from "./components/ui.tsx";
import {
  Fields,
  fieldValues,
  serializeFields,
  type Field,
} from "./components/forms.tsx";
import { AuthContext, useAuth } from "./auth-context.ts";
export { useAuth } from "./auth-context.ts";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const refresh = async () => {
    try {
      const result = await request<Session | User>(endpoints.me);
      const data = result.data;
      const normalized =
        "user" in data ? (data as Session) : { user: data as User };
      setSession(normalized);
      if (normalized.csrf_token) setCsrfToken(normalized.csrf_token);
      setError(null);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setSession(null);
        setError(null);
      } else
        setError(
          cause instanceof Error
            ? cause
            : new Error("Unable to load your session."),
        );
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  const logout = async () => {
    await request(endpoints.auth("logout"), { method: "POST", body: {} });
    setSession(null);
    setCsrfToken(null);
    setViewerGrant(null);
    for (const key of Object.keys(sessionStorage))
      if (key.startsWith("gitknot:draft:")) sessionStorage.removeItem(key);
  };
  return (
    <AuthContext value={{ session, loading, error, refresh, logout }}>
      {children}
    </AuthContext>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const location = useLocation();
  if (auth.loading) return <Loading label="Loading your session" />;
  if (auth.error)
    return (
      <ErrorNotice
        error={auth.error}
        retry={() => {
          void auth.refresh();
        }}
      />
    );
  if (!auth.session)
    return (
      <Navigate
        to={`/auth/login?return_to=${encodeURIComponent(location.pathname + location.search)}`}
        replace
      />
    );
  return children;
}

const authFields: Record<string, Field[]> = {
  login: [
    {
      name: "email",
      label: "Email address",
      type: "email",
      required: true,
      autoComplete: "username",
    },
    {
      name: "password",
      label: "Password",
      type: "password",
      required: true,
      autoComplete: "current-password",
    },
  ],
  signup: [
    { name: "username", label: "Username", required: true },
    { name: "display_name", label: "Your name", required: true },
    { name: "email", label: "Email address", type: "email", required: true },
    {
      name: "password",
      label: "Password",
      type: "password",
      required: true,
      help: "Use a unique password with at least 12 characters.",
    },
  ],
  verify: [
    {
      name: "token",
      label: "Verification code",
      required: true,
      help: "Use the code from your GitKnot verification email.",
    },
  ],
  recover: [
    { name: "email", label: "Email address", type: "email", required: true },
  ],
  reset: [
    { name: "token", label: "Recovery code", required: true },
    {
      name: "password",
      label: "New password",
      type: "password",
      required: true,
      help: "Use at least 12 characters.",
    },
    { name: "code", label: "Authenticator code (if enabled)" },
    {
      name: "recovery_code",
      label: "MFA recovery code (instead of authenticator)",
    },
  ],
};
const authTitles: Record<string, [string, string, string]> = {
  login: [
    "Sign in to GitKnot",
    "",
    "Sign in",
  ],
  signup: [
    "Create your account",
    "A place for your code and the people you build with.",
    "Create account",
  ],
  verify: [
    "Verify your email",
    "Enter the code from your verification email.",
    "Verify email",
  ],
  recover: [
    "Reset your password",
    "We’ll send recovery instructions if an account uses this address.",
    "Send recovery email",
  ],
  reset: [
    "Choose a new password",
    "Choose a new password to regain access to your account.",
    "Reset password",
  ],
};

export function AuthPage() {
  const { action = "login" } = useParams();
  if (!authFields[action]) return <Navigate to="/auth/login" replace />;
  return <AuthForm key={action} action={action} />;
}

function AuthForm({ action }: { action: string }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const mutation = useMutation();
  const fields = authFields[action]!;
  const [values, setValues] = useState(
    fieldValues(fields, { token: params.get("token") || "" }),
  );
  const [success, setSuccess] = useState(false);
  const [mfa, setMfa] = useState<Record<string, unknown> | null>(null);
  const [code, setCode] = useState("");
  const [factor, setFactor] = useState("code");
  const [passkeyPending, setPasskeyPending] = useState(false);
  const [passkeyError, setPasskeyError] = useState<Error | null>(null);
  const [title, description, label] = authTitles[action]!;
  const finishLogin = async () => {
    setViewerGrant(null);
    await auth.refresh();
    const redirect = params.get("return_to");
    navigate(
      redirect?.startsWith("/") && !redirect.startsWith("//") ? redirect : "/",
      { replace: true },
    );
  };
  return (
    <main className="auth-layout">
      <section className="auth-content">
        <div className="auth-form">
          <Link to="/" className="auth-logo">
            <img src="/favicon.svg" alt="" width="32" height="32" />
            GitKnot
          </Link>
          <h1>{title}</h1>
          {description && <p>{description}</p>}
          {success ? (
            <Notice tone="success">
              {action === "recover"
                ? "Check your email for recovery instructions."
                : action === "signup"
                  ? "Check your email for the next step to verify and finish setting up your account."
                  : action === "verify"
                    ? "Email verified. You’re ready to continue."
                    : "Your password has been reset."}
              <p>
                <Link
                  to={
                    action === "signup" || action === "verify"
                      ? "/"
                      : "/auth/login"
                  }
                >
                  Continue <ArrowRight size={14} />
                </Link>
              </p>
            </Notice>
          ) : mfa ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void mutation
                  .run(endpoints.auth("mfa/verify"), {
                    method: "POST",
                    body: { ...mfa, [factor]: code },
                  })
                  .then((result) => {
                    if (result) void finishLogin();
                  });
              }}
            >
              <div className="field">
                <label htmlFor="mfa-factor">Verification method</label>
                <select
                  id="mfa-factor"
                  value={factor}
                  onChange={(event) => {
                    setFactor(event.target.value);
                    setCode("");
                  }}
                >
                  <option value="code">Authenticator code</option>
                  <option value="recovery_code">Recovery code</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="mfa-code">Authentication code</label>
                <input
                  id="mfa-code"
                  autoComplete="one-time-code"
                  inputMode={factor === "code" ? "numeric" : "text"}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  required
                  autoFocus
                />
              </div>
              <ErrorNotice error={mutation.error} />
              <Button variant="primary" type="submit" busy={mutation.pending}>
                Verify and sign in
              </Button>
            </form>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void (async () => {
                  const result = await mutation.run(endpoints.auth(action), {
                    method: "POST",
                    body: serializeFields(fields, values),
                  });
                  if (!result) return;
                  const data = record(result.data);
                  if (data.mfa_required) {
                    setMfa({ challenge_id: data.challenge_id });
                    return;
                  }
                  if (action === "login") await finishLogin();
                  else setSuccess(true);
                })();
              }}
            >
              <Fields fields={fields} values={values} setValues={setValues} />
              <ErrorNotice error={mutation.error} />
              {action === "login" && (
                <Link className="auth-recovery" to="/auth/recover">
                  Forgot your password?
                </Link>
              )}
              <Button type="submit" variant="primary" busy={mutation.pending}>
                {label}
              </Button>
            </form>
          )}
          {action === "login" && (
            <>
              <Button
                busy={passkeyPending}
                className="passkey-signin"
                onClick={() => {
                  setPasskeyPending(true);
                  setPasskeyError(null);
                  void authenticatePasskey()
                    .then(finishLogin)
                    .catch((cause) =>
                      setPasskeyError(
                        cause instanceof Error
                          ? cause
                          : new Error("Passkey sign-in failed."),
                      ),
                    )
                    .finally(() => setPasskeyPending(false));
                }}
              >
                Sign in with a passkey
              </Button>
              <ErrorNotice error={passkeyError} />
            </>
          )}
          {action === "login" && (
            <p className="auth-switch">
              <Link to="/auth/sso">Sign in with your organization</Link>
            </p>
          )}
          {action === "login" ? (
            <p className="auth-switch">
              New to GitKnot? <Link to="/auth/signup">Create an account</Link>
            </p>
          ) : (
            <p className="auth-switch">
              <Link to="/auth/login">Back to sign in</Link>
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
