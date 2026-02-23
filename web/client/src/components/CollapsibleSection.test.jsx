import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CollapsibleSection from "./CollapsibleSection.jsx";

describe("CollapsibleSection - rendering", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders title and children", () => {
    render(
      <CollapsibleSection title="Test Section" storageKey="test-key" defaultCollapsed={false}>
        <p>Child content</p>
      </CollapsibleSection>
    );

    expect(screen.getByRole("heading", { name: /test section/i })).toBeInTheDocument();
    expect(screen.getByText("Child content")).toBeInTheDocument();
  });

  it("hides children when defaultCollapsed is true", () => {
    render(
      <CollapsibleSection title="Collapsed Section" storageKey="collapsed-key" defaultCollapsed={true}>
        <p>Hidden content</p>
      </CollapsibleSection>
    );

    expect(screen.getByRole("heading", { name: /collapsed section/i })).toBeInTheDocument();
    expect(screen.queryByText("Hidden content")).not.toBeInTheDocument();
  });

  it("shows children when toggle is clicked", async () => {
    const user = userEvent.setup();
    render(
      <CollapsibleSection title="Toggle Section" storageKey="toggle-key" defaultCollapsed={true}>
        <p>Revealed content</p>
      </CollapsibleSection>
    );

    expect(screen.queryByText("Revealed content")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /toggle section/i }));

    expect(screen.getByText("Revealed content")).toBeInTheDocument();
  });

  it("has aria-expanded attribute", () => {
    render(
      <CollapsibleSection title="Aria Section" storageKey="aria-key" defaultCollapsed={false}>
        <p>Content</p>
      </CollapsibleSection>
    );

    const button = screen.getByRole("button", { name: /aria section/i });
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  it("has aria-expanded false when collapsed", () => {
    render(
      <CollapsibleSection title="Aria Collapsed" storageKey="aria-collapsed" defaultCollapsed={true}>
        <p>Content</p>
      </CollapsibleSection>
    );

    const button = screen.getByRole("button", { name: /aria collapsed/i });
    expect(button).toHaveAttribute("aria-expanded", "false");
  });
});
