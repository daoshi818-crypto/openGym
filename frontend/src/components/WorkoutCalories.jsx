import { t } from '../lib/i18n.js'
import Icon from './Icon.jsx'
import { kcalText, workoutCaloriesOf } from '../lib/workout-calories.js'

export default function WorkoutCalories({ workout, variant = 'card', sync }) {
  const view = workoutCaloriesOf(workout, sync)
  const compact = variant === 'inline'
  if (compact && view.kcal == null) return null
  const label = view.status === 'pending' ? t('Waiting for watch data')
    : view.status === 'partial' ? t('Partial watch data')
      : t('Training calories')
  return <div className={'workout-calories workout-calories-' + variant} aria-label={label}>
    <span className="workout-calories-icon"><Icon name="flame" /></span>
    <span className="workout-calories-copy">
      <span className="workout-calories-label">{label}</span>
      <span className="workout-calories-value">{view.kcal != null ? kcalText(view.kcal) : '–'} <small>{t('kcal')}</small></span>
      {!compact && <span className="workout-calories-source">{view.kcal != null ? t('Watch estimate') : view.status === 'pending' ? t('Waiting for watch data') : t('Not recorded')}</span>}
    </span>
  </div>
}

