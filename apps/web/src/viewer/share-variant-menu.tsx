/**
 * The share split button's picker half (the arrow): the one component
 * both share surfaces — the workbench's bar and the viewer's instrument
 * row — mount beside their main copy action. The items are the share
 * codec's variant vocabulary (`SHARE_VARIANTS`); children, when a
 * surface has more to offer (the workbench's server link), render below
 * a separator. The main action stays each surface's own button: the
 * default copy, its icon, and its busy gate differ by surface.
 */

import type { ReactElement, ReactNode } from "react";
import { Button } from "@slopcad/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@slopcad/ui/components/dropdown-menu";
import { ChevronDown } from "lucide-react";
import type { NativeShareVariant } from "../cad-projects/native-document-bridge";

import { SHARE_VARIANTS, SHARE_VARIANT_ORDER } from "./share-codec";

/** Props of {@link ShareVariantMenu}. */
export interface ShareVariantMenuProps {
  /** The picker trigger's accessible name (each surface names its own). */
  readonly ariaLabel: string;
  /** The trigger's busy gate (the surface's own disabled expression). */
  readonly disabled: boolean;
  /** Copies the picked emission variant (the surface's own action). */
  readonly onPick: (variant: NativeShareVariant) => void;
  /** The testid prefix: `<prefix>-variant` on the trigger, `-<variant>` per item. */
  readonly testidPrefix: string;
  /** Extra items below a separator (e.g. the workbench's server link). */
  readonly children?: ReactNode;
}

export function ShareVariantMenu({
  ariaLabel,
  children,
  disabled,
  onPick,
  testidPrefix,
}: ShareVariantMenuProps): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={ariaLabel}
            className="rounded-l-none px-1"
            data-testid={`${testidPrefix}-variant`}
            disabled={disabled}
            size="xs"
            variant="outline"
          />
        }
      >
        <ChevronDown className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64">
        {SHARE_VARIANT_ORDER.map((variant) => (
          <DropdownMenuItem
            data-testid={`${testidPrefix}-variant-${variant}`}
            key={variant}
            onClick={() => onPick(variant)}
          >
            <div className="flex flex-col">
              <span>{SHARE_VARIANTS[variant].label}</span>
              <span className="text-muted-foreground text-[11px]">
                {SHARE_VARIANTS[variant].hint}
              </span>
            </div>
          </DropdownMenuItem>
        ))}
        {children === undefined ? null : (
          <>
            <DropdownMenuSeparator />
            {children}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
