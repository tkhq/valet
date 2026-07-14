// @vitest-environment jsdom
/**
 * Field components (Task 10): focused on `JsonTextarea`'s parse-error
 * behavior, since that's the one with actual local-state logic (the rest
 * are thin wrappers over the house primitives).
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JsonTextarea, NumberField, SelectField } from "./fields";

describe("JsonTextarea", () => {
  it("calls onChange with the parsed value when the buffer is valid JSON", () => {
    const onChange = vi.fn();
    render(<JsonTextarea label="Details" value={undefined} onChange={onChange} />);
    const textarea = screen.getByLabelText("Details");
    fireEvent.change(textarea, { target: { value: '{"a":1}' } });
    expect(onChange).toHaveBeenCalledWith({ a: 1 });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows an inline error and does not call onChange for invalid JSON", () => {
    const onChange = vi.fn();
    render(<JsonTextarea label="Details" value={undefined} onChange={onChange} />);
    const textarea = screen.getByLabelText("Details");
    fireEvent.change(textarea, { target: { value: "{not json" } });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("round-trips an object value through JSON.stringify on mount", () => {
    render(<JsonTextarea label="Details" value={{ a: 1 }} onChange={() => {}} />);
    const textarea = screen.getByLabelText("Details") as HTMLTextAreaElement;
    expect(textarea.value).toContain('"a": 1');
  });
});

describe("SelectField", () => {
  it("renders every option and fires onChange with the selected value", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <SelectField
        label="Mode"
        value="a"
        onChange={onChange}
        options={[
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ]}
      />,
    );
    await user.selectOptions(screen.getByLabelText("Mode"), "B");
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

describe("NumberField", () => {
  it("propagates undefined when the input is cleared", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<NumberField label="Max items" value={5} onChange={onChange} />);
    const input = screen.getByLabelText("Max items");
    await user.clear(input);
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("propagates the parsed number for a valid input", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<NumberField label="Max items" value={undefined} onChange={onChange} />);
    await user.type(screen.getByLabelText("Max items"), "7");
    expect(onChange).toHaveBeenCalledWith(7);
  });
});
