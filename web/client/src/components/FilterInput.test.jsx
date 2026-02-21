import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import FilterInput from "./FilterInput.jsx";

describe("FilterInput", () => {
  it("renders with placeholder and value", () => {
    render(
      <FilterInput
        value="test"
        onChange={() => {}}
        placeholder="Search..."
      />
    );
    const input = screen.getByPlaceholderText("Search...");
    expect(input).toHaveValue("test");
  });

  it("calls onChange when user types", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <FilterInput value="" onChange={onChange} placeholder="Filter" />
    );
    const input = screen.getByPlaceholderText("Filter");
    await user.type(input, "example");
    expect(onChange).toHaveBeenCalled();
  });

  it("shows dropdown when options provided and input focused", async () => {
    const user = userEvent.setup();
    const options = [
      { value: "a", count: 10 },
      { value: "b", count: 5 },
    ];
    render(
      <FilterInput
        value=""
        onChange={() => {}}
        placeholder="Filter"
        options={options}
      />
    );
    const input = screen.getByPlaceholderText("Filter");
    await user.click(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
  });

  it("calls onChange with selected value when option clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const options = [{ value: "selected", count: 1 }];
    render(
      <FilterInput
        value=""
        onChange={onChange}
        placeholder="Filter"
        options={options}
      />
    );
    await user.click(screen.getByPlaceholderText("Filter"));
    await user.click(screen.getByRole("option", { name: /selected/i }));
    expect(onChange).toHaveBeenCalledWith("selected");
  });
});
