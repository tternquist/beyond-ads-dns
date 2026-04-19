import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AuthSettings from "./AuthSettings.jsx";

function defaultProps(overrides = {}) {
  return {
    canSetInitialPassword: false,
    authEnabled: false,
    adminCurrentPassword: "",
    setAdminCurrentPassword: vi.fn(),
    adminNewPassword: "",
    setAdminNewPassword: vi.fn(),
    adminConfirmPassword: "",
    setAdminConfirmPassword: vi.fn(),
    adminPasswordLoading: false,
    adminPasswordStatus: null,
    adminPasswordError: null,
    handleSetPassword: vi.fn(),
    ...overrides,
  };
}

describe("AuthSettings", () => {
  it("renders Change Password button when auth is already set up", () => {
    render(<AuthSettings {...defaultProps()} />);
    expect(screen.getByRole("button", { name: /change password/i })).toBeInTheDocument();
  });

  it("renders Set Password button when no password is set yet", () => {
    render(<AuthSettings {...defaultProps({ canSetInitialPassword: true })} />);
    expect(screen.getByRole("button", { name: /set password/i })).toBeInTheDocument();
  });

  it("shows current password field when auth is enabled", () => {
    render(<AuthSettings {...defaultProps({ authEnabled: true })} />);
    expect(screen.getByPlaceholderText(/enter current password/i)).toBeInTheDocument();
  });

  it("hides current password field when auth is not enabled", () => {
    render(<AuthSettings {...defaultProps({ authEnabled: false })} />);
    expect(screen.queryByPlaceholderText(/enter current password/i)).not.toBeInTheDocument();
  });

  it("button is disabled when new password field is empty", () => {
    render(<AuthSettings {...defaultProps({ adminNewPassword: "" })} />);
    expect(screen.getByRole("button", { name: /change password/i })).toBeDisabled();
  });

  it("button is disabled when passwords do not match", () => {
    render(
      <AuthSettings
        {...defaultProps({
          adminNewPassword: "abc123",
          adminConfirmPassword: "different",
        })}
      />
    );
    expect(screen.getByRole("button", { name: /change password/i })).toBeDisabled();
  });

  it("button is disabled when auth is enabled but current password is empty", () => {
    render(
      <AuthSettings
        {...defaultProps({
          authEnabled: true,
          adminNewPassword: "abc123",
          adminConfirmPassword: "abc123",
          adminCurrentPassword: "",
        })}
      />
    );
    expect(screen.getByRole("button", { name: /change password/i })).toBeDisabled();
  });

  it("button is enabled when all required fields are filled and passwords match", () => {
    render(
      <AuthSettings
        {...defaultProps({
          authEnabled: true,
          adminCurrentPassword: "old",
          adminNewPassword: "newPass",
          adminConfirmPassword: "newPass",
        })}
      />
    );
    expect(screen.getByRole("button", { name: /change password/i })).toBeEnabled();
  });

  it("button is enabled when canSetInitialPassword and passwords match", () => {
    render(
      <AuthSettings
        {...defaultProps({
          canSetInitialPassword: true,
          authEnabled: false,
          adminNewPassword: "myPass",
          adminConfirmPassword: "myPass",
        })}
      />
    );
    expect(screen.getByRole("button", { name: /set password/i })).toBeEnabled();
  });

  it("calls handleSetPassword when button is clicked", async () => {
    const handleSetPassword = vi.fn();
    const user = userEvent.setup();
    render(
      <AuthSettings
        {...defaultProps({
          adminNewPassword: "abc123",
          adminConfirmPassword: "abc123",
          handleSetPassword,
        })}
      />
    );
    await user.click(screen.getByRole("button", { name: /change password/i }));
    expect(handleSetPassword).toHaveBeenCalledTimes(1);
  });

  it("shows Saving... text when loading", () => {
    render(<AuthSettings {...defaultProps({ adminPasswordLoading: true })} />);
    expect(screen.getByRole("button", { name: /saving/i })).toBeInTheDocument();
  });

  it("shows success status message", () => {
    render(<AuthSettings {...defaultProps({ adminPasswordStatus: "Password updated!" })} />);
    expect(screen.getByText("Password updated!")).toBeInTheDocument();
  });

  it("shows error message", () => {
    render(<AuthSettings {...defaultProps({ adminPasswordError: "Wrong current password" })} />);
    expect(screen.getByText("Wrong current password")).toBeInTheDocument();
  });

  it("calls setter when new password input changes", async () => {
    const setAdminNewPassword = vi.fn();
    const user = userEvent.setup();
    render(<AuthSettings {...defaultProps({ setAdminNewPassword })} />);
    const input = screen.getByPlaceholderText(/enter new password/i);
    await user.type(input, "x");
    expect(setAdminNewPassword).toHaveBeenCalled();
  });

  it("calls setter when confirm password input changes", async () => {
    const setAdminConfirmPassword = vi.fn();
    const user = userEvent.setup();
    render(<AuthSettings {...defaultProps({ setAdminConfirmPassword })} />);
    const input = screen.getByPlaceholderText(/confirm new password/i);
    await user.type(input, "x");
    expect(setAdminConfirmPassword).toHaveBeenCalled();
  });

  it("shows initial password prompt text when no password is set", () => {
    render(<AuthSettings {...defaultProps({ canSetInitialPassword: true })} />);
    expect(screen.getByText(/set a password to protect the ui/i)).toBeInTheDocument();
  });

  it("shows change password prompt text when password exists", () => {
    render(<AuthSettings {...defaultProps({ canSetInitialPassword: false })} />);
    expect(screen.getByText(/change the admin password/i)).toBeInTheDocument();
  });
});
