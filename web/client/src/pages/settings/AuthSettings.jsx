/**
 * Admin password settings section for the System Settings page.
 */
export default function AuthSettings({
  canSetInitialPassword,
  authEnabled,
  adminCurrentPassword,
  setAdminCurrentPassword,
  adminNewPassword,
  setAdminNewPassword,
  adminConfirmPassword,
  setAdminConfirmPassword,
  adminPasswordLoading,
  adminPasswordStatus,
  adminPasswordError,
  handleSetPassword,
}) {
  return (
    <>
      <h3>Admin Password</h3>
      <p className="muted" style={{ marginBottom: "0.5rem" }}>
        {canSetInitialPassword
          ? "Set a password to protect the UI. Once set, you will need to log in to access the dashboard."
          : "Change the admin password used to log in to the UI."}
      </p>
      {authEnabled && (
        <div className="form-group">
          <label className="field-label">Current password</label>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={adminCurrentPassword}
            onChange={(e) => setAdminCurrentPassword(e.target.value)}
            placeholder="Enter current password"
            style={{ maxWidth: "250px" }}
          />
        </div>
      )}
      <div className="form-group">
        <label className="field-label">
          {canSetInitialPassword ? "Password" : "New password"}
        </label>
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          value={adminNewPassword}
          onChange={(e) => setAdminNewPassword(e.target.value)}
          placeholder={
            canSetInitialPassword
              ? "Choose a password"
              : "Enter new password"
          }
          style={{ maxWidth: "250px" }}
        />
      </div>
      <div className="form-group">
        <label className="field-label">Confirm password</label>
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          value={adminConfirmPassword}
          onChange={(e) => setAdminConfirmPassword(e.target.value)}
          placeholder="Confirm new password"
          style={{ maxWidth: "250px" }}
        />
      </div>
      <button
        className="button primary"
        onClick={handleSetPassword}
        disabled={
          adminPasswordLoading ||
          !adminNewPassword ||
          adminNewPassword !== adminConfirmPassword ||
          (authEnabled && !adminCurrentPassword)
        }
      >
        {adminPasswordLoading
          ? "Saving..."
          : canSetInitialPassword
            ? "Set password"
            : "Change password"}
      </button>
      {adminPasswordStatus && (
        <p className="status" style={{ marginTop: "0.5rem" }}>
          {adminPasswordStatus}
        </p>
      )}
      {adminPasswordError && (
        <div className="error" style={{ marginTop: "0.5rem" }}>
          {adminPasswordError}
        </div>
      )}
    </>
  );
}
