export type VerificationStatus =
  | "unverified"
  | "pending"
  | "verified"
  | "failed"
  | "reachable_but_unverified"
  | "broken"
  | "temporarily_unavailable"
  | "unsafe"
  | "unknown";

export type VerificationClassification =
  | "verified"
  | "reachable_but_unverified"
  | "broken"
  | "temporarily_unavailable"
  | "unsafe"
  | "unknown";

export type VerificationCode =
  | "http_result"
  | "invalid_url"
  | "unsupported_scheme"
  | "unsafe_destination"
  | "dns_failure"
  | "timeout"
  | "network_error"
  | "tls_error"
  | "redirect_loop"
  | "too_many_redirects"
  | "invalid_redirect"
  | "protocol_downgrade";

export type HttpMethod = "HEAD" | "GET";

export type VerificationAttempt = {
  method: HttpMethod;
  url: string;
  resolvedAddress: string | null;
  addressFamily: 4 | 6 | null;
  httpStatus: number | null;
  startedAt: Date;
  finishedAt: Date;
};

export type RedirectHop = {
  fromUrl: string;
  status: 301 | 302 | 303 | 307 | 308;
  location: string;
  resolvedUrl: string | null;
};

export type TerminalOutcome = {
  code: VerificationCode;
  attempts: VerificationAttempt[];
  redirectChain: RedirectHop[];
  finalUrl: string | null;
  httpStatus: number | null;
  checkedAt: Date;
};

export type LinkVerificationResult = TerminalOutcome & {
  linkId: number;
  gameId: number;
  originalUrl: string;
  classification: VerificationClassification;
};

export type LinkVerificationSnapshot = {
  id: number;
  gameId: number;
  url: string;
  updatedAt: Date;
  verificationStatus: VerificationStatus;
  verificationMethod: "manual" | "http" | "provider_api" | null;
  httpStatus: number | null;
  redirectUrl: string | null;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
};

export type LinkVerificationUpdate = {
  verificationStatus: VerificationClassification;
  verificationMethod: "http";
  httpStatus: number | null;
  redirectUrl: string | null;
  verifiedAt: Date | null;
  lastCheckedAt: Date;
  updatedAt: Date;
};

export type LinkVerificationPlanItem =
  | { action: "update"; snapshot: LinkVerificationSnapshot; changes: LinkVerificationUpdate }
  | {
      action: "skip";
      linkId: number;
      originalUrl: string;
      reason: "manual_verification_preserved" | "no_metadata_change";
    };

export type GameLinkVerificationPlan = {
  gameId: number;
  dryRun: boolean;
  linksRead: number;
  verificationResults: LinkVerificationResult[];
  items: LinkVerificationPlanItem[];
};

export type WriteConflict = { linkId: number; code: "write_conflict" };

export type GameLinkVerificationResult = {
  gameId: number;
  dryRun: boolean;
  status: "planned" | "applied" | "partially_applied" | "no_changes";
  plan: GameLinkVerificationPlan;
  affectedRows: number;
  conflicts: WriteConflict[];
};

export type PresentedVerificationAttempt = Omit<
  VerificationAttempt,
  "url" | "startedAt" | "finishedAt"
> & {
  url: string;
  startedAt: string;
  finishedAt: string;
};

export type PresentedRedirectHop = {
  fromUrl: string;
  status: 301 | 302 | 303 | 307 | 308;
  location: string;
  resolvedUrl: string | null;
};

export type PresentedLinkVerificationResult = {
  linkId: number;
  gameId: number;
  originalUrl: string;
  classification: VerificationClassification;
  code: VerificationCode;
  attempts: PresentedVerificationAttempt[];
  redirectChain: PresentedRedirectHop[];
  finalUrl: string | null;
  httpStatus: number | null;
  checkedAt: string;
};

export type PresentedLinkVerificationUpdate = Omit<
  LinkVerificationUpdate,
  "redirectUrl" | "verifiedAt" | "lastCheckedAt" | "updatedAt"
> & {
  redirectUrl: string | null;
  verifiedAt: string | null;
  lastCheckedAt: string;
  updatedAt: string;
};

export type PresentedPlanItem =
  | {
      action: "update";
      linkId: number;
      originalUrl: string;
      changes: PresentedLinkVerificationUpdate;
    }
  | {
      action: "skip";
      linkId: number;
      originalUrl: string;
      reason: "manual_verification_preserved" | "no_metadata_change";
    };

export type PresentedGameLinkVerificationResult = {
  gameId: number;
  dryRun: boolean;
  status: "planned" | "applied" | "partially_applied" | "no_changes";
  links: PresentedLinkVerificationResult[];
  planItems: PresentedPlanItem[];
  affectedRows: number;
  conflicts: WriteConflict[];
};
