import React, { useState } from 'react';
import { School, Book, Text, Star, Trophy, Target, Tag, Edit, Check } from '@icon-park/react';
import type { WorkbenchApi } from '../store';
import { FIELD_DEFS } from '../engine';
import { PROFILE_CATEGORIES, type ProfileCategory } from '../model';

const CATEGORY_ICONS: Record<ProfileCategory, React.ComponentType<{ size?: number | string; theme?: string; fill?: string | string[] }>> = {
  basic: School,
  academic: Book,
  english: Text,
  performance: Star,
  awards: Trophy,
  research: Target,
  other: Tag,
};

/** 我的信息：长期个人资料（不属于任何一份报告） */
const ProfileView: React.FC<{ api: WorkbenchApi; notify: (msg: string) => void }> = ({ api, notify }) => {
  const { profile } = api.state;
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const startEdit = (key: string, value: string) => {
    setEditing(key);
    setDraft(value === '未提供' ? '' : value);
  };

  const save = (key: string) => {
    api.updateProfileField(key, draft);
    const fd = FIELD_DEFS.find((f) => f.key === key);
    notify(`已更新「${fd?.label ?? key}」并同步至我的信息，可在政策解读中重新分析`);
    setEditing(null);
  };

  return (
    <div className='ra-container'>
      <div className='ra-head'>
        <div>
          <div className='ra-head__title'>
            <span className='ra-head__title-icon'>
              <School size={17} theme='outline' fill='currentColor' />
            </span>
            我的信息
          </div>
          <div className='ra-head__sub'>长期个人资料 · 分析中补充的信息会自动同步到这里 · 编辑后请重新分析以更新结果</div>
        </div>
      </div>

      <div className='ra-profile'>
        <div className='ra-card ra-profile__intro'>
          这里保存的是你的长期资料，不属于任何一份报告。重新分析时，系统会基于「我的信息」+ 当时的政策版本生成新的报告快照；旧报告不会因这里的修改而改变。
        </div>

        <div className='ra-profile__grid'>
          {PROFILE_CATEGORIES.map((cat) => {
            const Icon = CATEGORY_ICONS[cat.key];
            const fields = FIELD_DEFS.filter((f) => f.category === cat.key).map((f) => ({
              key: f.key,
              label: f.label,
              hint: f.hint,
              field: profile.fields[f.key],
            }));
            return (
              <div key={cat.key} className='ra-card ra-cat'>
                <div className='ra-cat__head'>
                  <span className='ra-cat__icon'>
                    <Icon size={15} theme='outline' fill='currentColor' />
                  </span>
                  <div>
                    <div className='ra-cat__name'>{cat.label}</div>
                    <div className='ra-cat__hint'>{cat.hint}</div>
                  </div>
                </div>
                {fields.map(({ key, label, field, hint }) => {
                  const value = field?.value ?? '未提供';
                  const isEditing = editing === key;
                  return (
                    <div key={key} className='ra-field'>
                      <span className='ra-field__label'>{label}</span>
                      {isEditing ? (
                        <>
                          <input
                            className='ra-field__input'
                            value={draft}
                            placeholder={hint}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') save(key);
                              if (e.key === 'Escape') setEditing(null);
                            }}
                            autoFocus
                          />
                          <span className='ra-field__actions'>
                            <button type='button' className='ra-field__save' onClick={() => save(key)}>
                              <Check size={12} theme='outline' fill='currentColor' />
                              保存
                            </button>
                          </span>
                        </>
                      ) : (
                        <>
                          <span className={`ra-field__value${value === '未提供' ? ' ra-field__value--empty' : ''}`}>
                            {value}
                          </span>
                          <span className='ra-field__time'>{field ? `更新于 ${field.updatedAt}` : '未填写'}</span>
                          <button type='button' className='ra-field__edit' onClick={() => startEdit(key, value)} aria-label={`编辑${label}`}>
                            <Edit size={14} theme='outline' fill='currentColor' />
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default ProfileView;
