import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LoginPage from "./LoginPage.jsx";

describe("LoginPage", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("renders login form with username and password fields", () => {
    render(
      <LoginPage
        onLogin={() => {}}
        authStatus={{ authenticated: false, authEnabled: true }}
      />
    );
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("shows Sign in to continue subtitle", () => {
    render(
      <LoginPage
        onLogin={() => {}}
        authStatus={{ authenticated: false, authEnabled: true }}
      />
    );
    expect(screen.getByText("Sign in to continue")).toBeInTheDocument();
  });

  it("pre-fills username from authStatus", () => {
    render(
      <LoginPage
        onLogin={() => {}}
        authStatus={{ authenticated: false, authEnabled: true, username: "custom" }}
      />
    );
    expect(screen.getByLabelText(/username/i)).toHaveValue("custom");
  });

  it("displays error when login fails with 401", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: "Invalid credentials" }),
    });

    render(
      <LoginPage
        onLogin={() => {}}
        authStatus={{ authenticated: false, authEnabled: true }}
      />
    );
    await user.type(screen.getByLabelText(/password/i), "wrong");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await screen.findByRole("alert");
    expect(screen.getByText(/invalid credentials|invalid username or password/i)).toBeInTheDocument();
  });

  it("calls onLogin when login succeeds", async () => {
    const user = userEvent.setup();
    const onLogin = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    render(
      <LoginPage
        onLogin={onLogin}
        authStatus={{ authenticated: false, authEnabled: true }}
      />
    );
    await user.type(screen.getByLabelText(/password/i), "correct");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(onLogin).toHaveBeenCalled();
  });
});
