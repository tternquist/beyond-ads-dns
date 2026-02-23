import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import StatCard from "./StatCard.jsx";

describe("StatCard - rendering", () => {
  it("renders label and value", () => {
    render(<StatCard label="Test Label" value="123" />);

    expect(screen.getByText("Test Label")).toBeInTheDocument();
    expect(screen.getByText("123")).toBeInTheDocument();
  });

  it("renders subtext when provided", () => {
    render(<StatCard label="Label" value="42" subtext="lists + manual" />);

    expect(screen.getByText("lists + manual")).toBeInTheDocument();
  });

  it("does not render subtext when not provided", () => {
    render(<StatCard label="Label" value="42" />);

    expect(screen.queryByText("lists + manual")).not.toBeInTheDocument();
  });

  it("renders View details link when drillDownOutcome and onDrillDown are provided", () => {
    const onDrillDown = vi.fn();
    render(
      <StatCard
        label="Blocked"
        value="100"
        drillDownOutcome="blocked"
        onDrillDown={onDrillDown}
      />
    );

    expect(screen.getByText(/view details/i)).toBeInTheDocument();
  });

  it("calls onDrillDown when clicked and drill-down is enabled", async () => {
    const user = userEvent.setup();
    const onDrillDown = vi.fn();
    render(
      <StatCard
        label="Blocked"
        value="100"
        drillDownOutcome="blocked"
        onDrillDown={onDrillDown}
      />
    );

    await user.click(screen.getByRole("button"));

    expect(onDrillDown).toHaveBeenCalledWith("blocked");
  });

  it("has role button when drill-down is enabled", () => {
    render(
      <StatCard
        label="Blocked"
        value="100"
        drillDownOutcome="blocked"
        onDrillDown={vi.fn()}
      />
    );

    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("does not have role button when drill-down is not enabled", () => {
    render(<StatCard label="Blocked" value="100" />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
