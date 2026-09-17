/**
 * Appearance controls: a one-press switch for the topbar and the explicit three-way
 * choice inside the account menu. Both read the active palette in words, so the state is
 * never communicated by the icon or colour alone.
 */
import { useTheme, type ThemePreference } from '../context/ThemeContext';
import { IconCheck, IconMonitor, IconMoon, IconSun } from './Icons';

const OPTIONS: { value: ThemePreference; label: string; icon: typeof IconSun }[] = [
  { value: 'light', label: 'Light', icon: IconSun },
  { value: 'dark', label: 'Dark', icon: IconMoon },
  { value: 'system', label: 'Match system', icon: IconMonitor },
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
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            className={`menu-item ${selected ? 'is-selected' : ''}`}
            aria-pressed={selected}
            onClick={() => setPreference(option.value)}
          >
            <Icon size={17} />
            <span>{option.label}</span>
            {selected ? (
              <span className="menu-item__selected">
                <IconCheck size={15} />
                Selected
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
