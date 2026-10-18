import { Component, Suspense, use, useState, type ComponentType, type ReactNode } from "react";
import { createLoader } from "@/lib/lazyLoader";

interface LazyOptions<P> {
  /** Shown while the code loads. */
  loading: (props: P) => ReactNode;
  /** Shown when the code could not be loaded, or the component failed while rendering. */
  failed: (props: P, retry: () => void) => ReactNode;
}

export type LazyComponent<P> = ComponentType<P> & {
  /** Fetches the code ahead of use, so that showing it later need not wait. */
  preload: () => void;
};

/**
 * A component whose code is split from the initial bundle and loaded on first render.
 *
 * Unlike React.lazy, a load that failed can be tried again (React.lazy keeps the failure for good),
 * and a component loaded ahead of use renders at once instead of suspending for a moment.
 */
export function lazyComponent<P extends object>(load: () => Promise<ComponentType<P>>, options: LazyOptions<P>): LazyComponent<P> {
  const loader = createLoader(load);

  function Loaded(props: P) {
    // A suspended render must consume the same promise when it resumes, even once loaded.
    const Target = use(loader.load());
    return <Target {...props} />;
  }

  function Lazy(props: P) {
    // Capture the fast path before mounting Suspense; never switch paths as a load completes.
    const [Preloaded] = useState(() => loader.loaded());
    const [attempt, setAttempt] = useState(0);
    const retry = () => {
      loader.reset();
      setAttempt((value) => value + 1);
    };
    return (
      <LoadBoundary key={attempt} fallback={() => options.failed(props, retry)}>
        <Suspense fallback={options.loading(props)}>
          {Preloaded ? <Preloaded {...props} /> : <Loaded {...props} />}
        </Suspense>
      </LoadBoundary>
    );
  }

  // A failed preload is tried again when the component is first shown (see createLoader).
  return Object.assign(Lazy, { preload: loader.preload });
}

class LoadBoundary extends Component<{ fallback: () => ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback() : this.props.children;
  }
}

function PaneMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 h-full text-center text-[0.8125rem] text-muted-foreground">
      {children}
    </div>
  );
}

/** Loading and failure states for a pane that fills a tab or the side panel. */
export const paneStates: LazyOptions<object> = {
  loading: () => <PaneMessage>読み込み中…</PaneMessage>,
  failed: (_props, retry) => (
    <PaneMessage>
      <p>この画面を表示できませんでした。繰り返す場合はアプリを再起動してください。</p>
      <button className="rounded-md border px-3 py-1.5 text-foreground hover:bg-muted" onClick={retry}>再試行</button>
    </PaneMessage>
  ),
};
