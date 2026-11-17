import { useAtom } from "jotai";
import { Icon } from "@/components/ui/icon";
import { ContextMenuItem, ContextMenuLabel, ContextMenuSeparator } from "@/components/ui/context-menu";
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { projectMachineOverridesAtom } from "../preferences/atoms.js";

export function ProjectMachineMenu({ projectId, surface }: {
  projectId: string; surface: "context" | "dropdown";
}) {
  const [overrides, setOverrides] = useAtom(projectMachineOverridesAtom);
  const selected = Object.hasOwn(overrides, projectId) ? overrides[projectId] : "inherit";
  const Item = surface === "context" ? ContextMenuItem : DropdownMenuItem;
  const Label = surface === "context" ? ContextMenuLabel : DropdownMenuLabel;
  const Separator = surface === "context" ? ContextMenuSeparator : DropdownMenuSeparator;
  return <>
    <Separator />
    <Label>Машины в этом проекте</Label>
    {([
      ["inherit", "Как в общих настройках"],
      ["machines", "Группировать по машинам"],
      ["plain", "Без групп машин"],
    ] as const).map(([value, label]) => <Item key={value}
      role="menuitemradio" aria-checked={selected === value}
      onSelect={(event) => {
        event.preventDefault();
        setOverrides((current) => {
          const next = { ...current };
          if (value === "inherit") delete next[projectId];
          else Object.defineProperty(next, projectId, { value, enumerable: true, configurable: true, writable: true });
          return next;
        });
      }}>
      {label}<span className="ml-auto inline-flex size-4 shrink-0 items-center justify-center">
        {selected === value && <Icon name="Check" className="size-4" />}
      </span>
    </Item>)}
  </>;
}
