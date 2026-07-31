import { Text, useInput } from "ink";
import { useState } from "react";

export interface OrgSelectOption {
  readonly label: string;
  readonly value: string | null;
}

export interface OrgSelectViewProps {
  readonly onSelect: (value: string | null) => void;
  readonly options: readonly OrgSelectOption[];
}

export const OrgSelectView = ({
  onSelect,
  options,
}: OrgSelectViewProps): React.JSX.Element => {
  const [index, setIndex] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow || key.leftArrow) {
      setIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow || key.rightArrow) {
      setIndex((current) => Math.min(options.length - 1, current + 1));
      return;
    }
    if (key.return) {
      const selected = options[index];
      if (selected) {
        onSelect(selected.value);
      }
    }
  });

  return (
    <>
      <Text color="cyan">Select organization scope</Text>
      <Text dimColor>↑/↓ to move · Enter to confirm</Text>
      {options.map((option, optionIndex) => {
        const selected = optionIndex === index;
        if (selected) {
          return (
            <Text color="green" key={option.value ?? "personal"}>
              ❯ {option.label}
            </Text>
          );
        }
        return (
          <Text key={option.value ?? "personal"}>
            {"  "}
            {option.label}
          </Text>
        );
      })}
    </>
  );
};
