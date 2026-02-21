import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DomainEditor from "./DomainEditor.jsx";

describe("DomainEditor", () => {
  it("renders empty state when no items", () => {
    render(
      <DomainEditor items={[]} onAdd={() => {}} onRemove={() => {}} />
    );
    expect(screen.getByPlaceholderText("example.com")).toBeInTheDocument();
    expect(screen.getByText("None")).toBeInTheDocument();
  });

  it("renders existing items as tags", () => {
    render(
      <DomainEditor
        items={["example.com", "test.org"]}
        onAdd={() => {}}
        onRemove={() => {}}
      />
    );
    expect(screen.getByText("example.com")).toBeInTheDocument();
    expect(screen.getByText("test.org")).toBeInTheDocument();
  });

  it("calls onAdd when valid domain entered and Add clicked", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(
      <DomainEditor items={[]} onAdd={onAdd} onRemove={() => {}} />
    );
    const input = screen.getByPlaceholderText("example.com");
    await user.type(input, "newdomain.com");
    await user.click(screen.getByRole("button", { name: /add/i }));
    expect(onAdd).toHaveBeenCalledWith("newdomain.com");
  });

  it("disables Add button when input empty", () => {
    render(
      <DomainEditor items={[]} onAdd={() => {}} onRemove={() => {}} />
    );
    const addBtn = screen.getByRole("button", { name: /add/i });
    expect(addBtn).toBeDisabled();
  });

  it("disables Add when input empty even with existing items", () => {
    render(
      <DomainEditor
        items={["existing.com"]}
        onAdd={() => {}}
        onRemove={() => {}}
      />
    );
    const addBtn = screen.getByRole("button", { name: /add/i });
    expect(addBtn).toBeDisabled();
  });

  it("calls onRemove when remove button clicked", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <DomainEditor
        items={["example.com"]}
        onAdd={() => {}}
        onRemove={onRemove}
      />
    );
    await user.click(screen.getByLabelText("Remove example.com"));
    expect(onRemove).toHaveBeenCalledWith("example.com");
  });
});
