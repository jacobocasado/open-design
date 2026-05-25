import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'default' | 'primary' | 'primary-ghost' | 'ghost' | 'subtle';
export type ButtonSize = 'default' | 'icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

function joinClassNames(...classNames: Array<string | false | null | undefined>) {
  return classNames.filter(Boolean).join(' ') || undefined;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, type = 'button', variant = 'default', size = 'default', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={joinClassNames(
        variant !== 'default' && variant,
        size === 'icon' && 'icon-btn',
        className,
      )}
      {...props}
    />
  );
});

export interface VisuallyHiddenProps {
  children: ReactNode;
  className?: string;
}

export function VisuallyHidden({ children, className }: VisuallyHiddenProps) {
  return <span className={joinClassNames('sr-only', className)}>{children}</span>;
}
