/**
 * Appearance controls: a one-press switch for the topbar and the explicit three-way
 * choice inside the account menu. Both read the active palette in words, so the state is
 * never communicated by the icon or colour alone.
 */
import { useTheme, type ThemePreference } from '../context/ThemeContext';
import { IconMoon, IconSun } from './Icons';

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Match system' },
];

export function ThemeToggleButton() {
  const { resolved, toggle } = useTheme();
  const label = resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <button type="button" className="icon-button" aria-label={label} title={label} onClick={toggle}>
      {resolved === 'dark' ? <IconSun /> : <IconMoon />}
    </button>
  );
}

export function ThemeOptions() {
  const { preference, setPreference } = useTheme();
  return (
    <div className="menu-popover__group" role="group" aria-label="Appearance">
      <span className="menu-popover__group-label">Appearance</span>
      {OPTIONS.map((option) => {
        const selected = preference === option.value;
        return (
          <button
            key={option.value}
            type="button"
            className={`menu-popover__option ${selected ? 'is-selected' : ''}`}
            aria-pressed={selected}
            onClick={() => setPreference(option.value)}
          >
            <span>{option.label}</span>
            {selected ? <span className="menu-popover__check">Selected</span> : null}
          </button>
        );
      })}
    </div>
  );
}
