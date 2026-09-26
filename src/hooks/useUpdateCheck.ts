import { useCallback, useRef, useState } from "react";

import { checkForUpdate, installUpdate } from "@/api/app";
import { toError } from "@/api/invoke";
import type { AvailableUpdate } from "@/types/menu";

export type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "current" }
  | { phase: "available"; update: AvailableUpdate }
  | { phase: "installing"; update: AvailableUpdate }
  | { phase: "failed"; message: string };

export interface UpdateCheck {
  state: UpdateState;
  /** Asks for a newer signed release. Grove never asks on its own. */
  check: () => void;
  /** Installs the release found by `check`; the app relaunches when it lands. */
  install: () => void;
  dismiss: () => void;
}

/** Manual update flow shared by Grove › Check for Updates… and Settings. */
export function useUpdateCheck(): UpdateCheck {
  const [state, setStateValue] = useState<UpdateState>({ phase: "idle" });
  const stateRef = useRef(state);
  const setState = useCallback((next: UpdateState) => {
    stateRef.current = next;
    setStateValue(next);
  }, []);

  const check = useCallback(() => {
    setState({ phase: "checking" });
    checkForUpdate()
      .then((update) =>
        setState(update === null ? { phase: "current" } : { phase: "available", update }),
      )
      .catch((error: unknown) => setState({ phase: "failed", message: toError(error).message }));
  }, [setState]);

  const install = useCallback(() => {
    const current = stateRef.current;
    if (current.phase !== "available") return;
    setState({ phase: "installing", update: current.update });
    installUpdate().catch((error: unknown) =>
      setState({ phase: "failed", message: toError(error).message }),
    );
  }, [setState]);

  const dismiss = useCallback(() => setState({ phase: "idle" }), [setState]);

  return { state, check, install, dismiss };
}
