// Button + IconButton. Owner: ui-foundation.
import type { ComponentProps, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@renderer/lib/cn';
import { Spinner } from './feedback';
import { Tooltip } from './tooltip';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-solid';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-ob-accent text-ob-accent-ink hover:bg-ob-accent-hover active:bg-[#7fa9d1] font-medium',
  secondary:
    'bg-ob-surface-2 text-ob-text border border-ob-border hover:bg-ob-surface-3 hover:border-[#2f404e] active:bg-[#263644] font-medium',
  ghost: 'text-ob-text-2 hover:bg-ob-hover hover:text-ob-text active:bg-ob-press',
  danger:
    'bg-ob-danger-soft text-ob-danger border border-[rgba(240,113,120,0.28)] hover:bg-[rgba(240,113,120,0.2)] active:bg-[rgba(240,113,120,0.26)] font-medium',
  'danger-solid': 'bg-ob-danger text-[#1a0c0d] hover:bg-[#f3868c] active:bg-[#e3666d] font-medium',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-small gap-1.5 rounded-ctl',
  md: 'h-8 px-3 text-ui gap-1.5 rounded-ctl',
  lg: 'h-9 px-4 text-ui gap-2 rounded-[7px]',
};

const ICON_SIZES: Record<ButtonSize, number> = { sm: 14, md: 15, lg: 16 };

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Lucide icon component or any node, shown before the label. */
  icon?: LucideIcon | ReactNode;
  /** Shown after the label. */
  iconRight?: LucideIcon | ReactNode;
  fullWidth?: boolean;
}

function renderIcon(icon: LucideIcon | ReactNode | undefined, size: number): ReactNode {
  if (!icon) return null;
  if (typeof icon === 'function' || (typeof icon === 'object' && icon !== null && '$$typeof' in icon && 'render' in (icon as object))) {
    const Icon = icon as LucideIcon;
    return <Icon size={size} aria-hidden />;
  }
  return icon as ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  icon,
  iconRight,
  fullWidth,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  const iconSize = ICON_SIZES[size];
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'ob-transition relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap outline-offset-1',
        'disabled:pointer-events-none disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={iconSize - 2} /> : renderIcon(icon, iconSize)}
      {children}
      {renderIcon(iconRight, iconSize)}
    </button>
  );
}

export type IconButtonSize = 'xs' | 'sm' | 'md' | 'lg';

const ICON_BTN_SIZES: Record<IconButtonSize, string> = {
  xs: 'size-5 rounded-[4px]',
  sm: 'size-6 rounded-[5px]',
  md: 'size-7 rounded-ctl',
  lg: 'size-8 rounded-ctl',
};
const ICON_BTN_ICON: Record<IconButtonSize, number> = { xs: 12, sm: 14, md: 16, lg: 16 };

export interface IconButtonProps extends Omit<ComponentProps<'button'>, 'children'> {
  /** Required: used as aria-label and tooltip text. */
  label: string;
  icon: LucideIcon | ReactNode;
  size?: IconButtonSize;
  variant?: 'ghost' | 'secondary' | 'danger' | 'primary';
  /** Toggled-on look (accent wash). */
  active?: boolean;
  shortcut?: string;
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
  /** Hide the tooltip (aria-label is kept). */
  noTooltip?: boolean;
  loading?: boolean;
}

const ICON_BTN_VARIANTS: Record<NonNullable<IconButtonProps['variant']>, string> = {
  ghost: 'text-ob-text-3 hover:text-ob-text hover:bg-ob-hover active:bg-ob-press',
  secondary: 'text-ob-text-2 bg-ob-surface-2 border border-ob-border hover:text-ob-text hover:bg-ob-surface-3',
  danger: 'text-ob-text-3 hover:text-ob-danger hover:bg-ob-danger-soft',
  primary: 'bg-ob-accent text-ob-accent-ink hover:bg-ob-accent-hover',
};

export function IconButton({
  label,
  icon,
  size = 'md',
  variant = 'ghost',
  active,
  shortcut,
  tooltipSide = 'top',
  noTooltip,
  loading,
  className,
  type = 'button',
  disabled,
  ...rest
}: IconButtonProps) {
  const btn = (
    <button
      type={type}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled || loading}
      className={cn(
        'ob-transition inline-flex shrink-0 select-none items-center justify-center outline-offset-1',
        'disabled:pointer-events-none disabled:opacity-40',
        ICON_BTN_SIZES[size],
        ICON_BTN_VARIANTS[variant],
        active && 'bg-ob-accent-soft text-ob-accent hover:bg-ob-accent-soft hover:text-ob-accent',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={ICON_BTN_ICON[size] - 2} /> : renderIcon(icon, ICON_BTN_ICON[size])}
    </button>
  );
  if (noTooltip) return btn;
  return (
    <Tooltip content={label} shortcut={shortcut} side={tooltipSide}>
      {btn}
    </Tooltip>
  );
}
