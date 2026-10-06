import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const PageTitleCountContext = createContext<(count: number) => void>(() => {});

export function titleWithCount(base: string, count: number): string {
  return count > 0 ? `(${count}) ${base}` : base;
}

const PageTitleContext = createContext<(title: string | undefined) => void>(() => {});

/** One document title owner keeps docks and child panels from replacing the open page's title. */
export function PageTitleProvider({ workspaceName, children }: { workspaceName: string; children: ReactNode }) {
  const [count, setCount] = useState(0);
  const [pageTitle, setPageTitle] = useState<string>();
  useEffect(() => {
    document.title = titleWithCount([pageTitle, workspaceName, "Valet"].filter(Boolean).join(" · "), count);
    return () => { document.title = "Valet"; };
  }, [pageTitle, workspaceName, count]);
  return <PageTitleContext.Provider value={setPageTitle}>
    <PageTitleCountContext.Provider value={setCount}>{children}</PageTitleCountContext.Provider>
  </PageTitleContext.Provider>;
}

/** Routes supply titles from their existing queries, including live renames. */
export function usePageTitle(title: string): void {
  const setPageTitle = useContext(PageTitleContext);
  useEffect(() => {
    setPageTitle(title);
    return () => setPageTitle(undefined);
  }, [title, setPageTitle]);
}

/** Notification refreshes update the badge without replacing the current page title. */
export function usePageTitleCount(count: number): void {
  const setCount = useContext(PageTitleCountContext);
  useEffect(() => {
    setCount(count);
    return () => setCount(0);
  }, [count, setCount]);
}
