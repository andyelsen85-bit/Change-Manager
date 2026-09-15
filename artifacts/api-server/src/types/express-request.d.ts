interface AuthenticatedExpressSession {
  uid: number;
  username: string;
  isAdmin: boolean;
  generation: number;
  regenerate(callback: (err?: unknown) => void): void;
  save(callback: (err?: unknown) => void): void;
  destroy(callback: (err?: unknown) => void): void;
}

declare global {
  namespace Express {
    interface Request {
      session?: AuthenticatedExpressSession;
      sessionID?: string;
    }
  }
}

export {};