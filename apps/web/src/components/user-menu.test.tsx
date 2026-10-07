import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import UserMenu from "./user-menu";

interface SignOutOptions {
  fetchOptions?: { onSuccess?: () => void };
}

interface NavigateOptions {
  to: string;
}

interface SessionPayload {
  data: {
    session: { id: string };
    user: { email: string; name: string };
  } | null;
  error: null;
  isPending: boolean;
}

const signedInSession: SessionPayload = {
  data: {
    session: { id: "session-1" },
    user: { email: "ada@slopcad.dev", name: "Ada Lovelace" },
  },
  error: null,
  isPending: false,
};

const pendingSession: SessionPayload = {
  data: null,
  error: null,
  isPending: true,
};

const signedOutSession: SessionPayload = {
  data: null,
  error: null,
  isPending: false,
};

const { navigateMock, signOutMock, useSessionMock } = vi.hoisted(() => ({
  navigateMock: vi.fn<(options: NavigateOptions) => void>(),
  signOutMock: vi.fn<(options: SignOutOptions) => void>(),
  useSessionMock: vi.fn<() => SessionPayload>(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => navigateMock,
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signOut: signOutMock,
    useSession: useSessionMock,
  },
}));

const previousAccountKey = ["trpc", "projects", "list"];

function renderWithQueryClient(ui: ReactElement) {
  render(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );
}

function renderUserMenu() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(previousAccountKey, { name: "A's project" });
  const clearSpy = vi.spyOn(queryClient, "clear");
  render(
    <QueryClientProvider client={queryClient}>
      <UserMenu />
    </QueryClientProvider>,
  );
  return { clearSpy, queryClient };
}

async function openAccountMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Ada Lovelace" }));
  await screen.findByText("My Account");
}

beforeEach(() => {
  navigateMock.mockReset();
  signOutMock.mockReset();
  useSessionMock.mockReset();
  signOutMock.mockImplementation((options) => {
    options.fetchOptions?.onSuccess?.();
  });
});

afterEach(cleanup);

describe("UserMenu", () => {
  it("renders the skeleton while the session is pending", () => {
    useSessionMock.mockReturnValue(pendingSession);

    renderWithQueryClient(<UserMenu />);

    expect(document.querySelector('[data-slot="skeleton"]')).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders the sign-in button when there is no session", () => {
    useSessionMock.mockReturnValue(signedOutSession);

    renderWithQueryClient(<UserMenu />);

    expect(screen.getByRole("button", { name: "Sign In" })).toBeTruthy();
  });

  it("renders the account menu with the signed-in user's name and email", async () => {
    useSessionMock.mockReturnValue(signedInSession);

    renderWithQueryClient(<UserMenu />);

    expect(screen.getByRole("button", { name: "Ada Lovelace" })).toBeTruthy();

    await openAccountMenu();

    expect(screen.getByText("ada@slopcad.dev")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Sign Out" })).toBeTruthy();
  });

  it("clears the query cache before navigating on sign-out success", async () => {
    useSessionMock.mockReturnValue(signedInSession);
    const { clearSpy, queryClient } = renderUserMenu();
    expect(queryClient.getQueryData(previousAccountKey)).toEqual({
      name: "A's project",
    });

    await openAccountMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign Out" }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledTimes(1);
    });
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith({ to: "/" });
    const clearCallOrder = clearSpy.mock.invocationCallOrder.at(0);
    const navigateCallOrder = navigateMock.mock.invocationCallOrder.at(0);
    if (clearCallOrder === undefined || navigateCallOrder === undefined) {
      throw new Error(
        "expected both queryClient.clear() and navigate() to have run",
      );
    }
    expect(clearCallOrder).toBeLessThan(navigateCallOrder);
    expect(queryClient.getQueryData(previousAccountKey)).toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it("keeps the cache and stays put when sign-out does not succeed", async () => {
    useSessionMock.mockReturnValue(signedInSession);
    signOutMock.mockImplementation(() => {});
    const { clearSpy, queryClient } = renderUserMenu();

    await openAccountMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign Out" }));

    await waitFor(() => {
      expect(signOutMock).toHaveBeenCalledTimes(1);
    });
    expect(clearSpy).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(previousAccountKey)).toEqual({
      name: "A's project",
    });
  });
});
