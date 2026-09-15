import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import SignInForm from "./sign-in-form";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ isPending: false, data: null, error: null }),
  },
}));

afterEach(cleanup);

describe("SignInForm", () => {
  it("renders the heading, both labelled fields, and the submit button", () => {
    render(<SignInForm onSwitchToSignUp={() => {}} />);

    expect(screen.getByRole("heading", { name: "Welcome Back" })).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign In" })).toBeTruthy();
  });

  it("runs field values through the form state and surfaces the zod validation error", async () => {
    render(<SignInForm onSwitchToSignUp={() => {}} />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "ada@slopcad.dev" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "short" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    expect(
      await screen.findByText("Password must be at least 8 characters"),
    ).toBeTruthy();
  });
});
