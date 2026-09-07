import type { AuthSessionDto } from "@cryptoanal/contracts";
import { createContext, useContext } from "react";

export const authSessionQueryKey = ["auth-session"] as const;

export type AuthenticatedSession = Extract<AuthSessionDto, { authenticated: true }>;
export const AuthContext = createContext<AuthenticatedSession | null>(null);

export function useAuthSession() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuthSession must be used inside AuthGate");
  return context;
}
