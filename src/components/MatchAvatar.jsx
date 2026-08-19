import { Icon } from './ui.jsx';

export const MATCH_AVATARS = [
  { id: 'nova', label: 'Nova', icon: 'rocket_launch', tone: 'violet' },
  { id: 'orbit', label: 'Orbit', icon: 'planet', tone: 'cyan' },
  { id: 'spark', label: 'Spark', icon: 'bolt', tone: 'pink' },
  { id: 'sage', label: 'Sage', icon: 'psychology', tone: 'green' },
  { id: 'pixel', label: 'Pixel', icon: 'smart_toy', tone: 'amber' },
  { id: 'comet', label: 'Comet', icon: 'flare', tone: 'blue' },
];

export const safeAvatarId = (value) => MATCH_AVATARS.some((item) => item.id === value) ? value : 'nova';

export function MatchAvatar({ avatarId, size = 'md', label }) {
  const avatar = MATCH_AVATARS.find((item) => item.id === safeAvatarId(avatarId)) || MATCH_AVATARS[0];
  return (
    <span className={`match-avatar match-avatar-${avatar.tone} is-${size}`} aria-label={label || `${avatar.label} avatar`} role="img">
      <Icon name={avatar.icon} size={size === 'lg' ? 26 : size === 'sm' ? 16 : 20} />
    </span>
  );
}

export function AvatarPicker({ value, onChange, label = 'Choose your lobby avatar' }) {
  return (
    <fieldset className="match-avatar-picker">
      <legend>{label}</legend>
      <div>
        {MATCH_AVATARS.map((avatar) => (
          <label key={avatar.id} className={value === avatar.id ? 'is-on' : ''} title={avatar.label}>
            <input type="radio" name="match-avatar" value={avatar.id} checked={value === avatar.id} onChange={() => onChange(avatar.id)} />
            <MatchAvatar avatarId={avatar.id} />
            <span>{avatar.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}