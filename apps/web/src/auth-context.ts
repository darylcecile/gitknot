import { createContext, useContext } from "react";
import type { Session } from "./api/types.ts";

export type AuthState = {
  session: Session | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("AuthProvider is required.");
  return context;
}
