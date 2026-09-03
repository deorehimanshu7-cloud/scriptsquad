import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useFieldStore } from '@/lib/state/field';
import { api } from '@/lib/api/client';

interface Field {
  user_id: string;
  updated_at: string;
  id: string;
  farm_id: string;
  name: string;
  geometry: { type: 'Polygon'; coordinates: number[][][] };
  centroid: { type: 'Point'; coordinates: [number, number] };
  area_hectares: number;
  status: 'active' | 'inactive' | 'archived';
  created_at: string;
}

export default function FieldsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const farmId = searchParams.get('farmId');
  
  const [fields, setFields] = useState<Field[]>([]);
  const [loading, setLoading] = useState(true);
  const { setCurrentField } = useFieldStore();

  useEffect(() => {
    fetchFields();
  }, [farmId]);

  const fetchFields = async () => {
    try {
      const response = await api.get<{ success: boolean; data: Field[] }>('/fields');
      if (response.success) {
        const filteredFields = farmId
          ? response.data.filter((f) => f.farm_id === farmId)
          : response.data;
        setFields(filteredFields);
      }
    } catch (error) {
      console.error('Failed to fetch fields:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleFieldClick = (field: Field) => {
    setCurrentField(field);
    navigate('/world');
  };

  const handleCreateField = () => {
    navigate(`/fields/new${farmId ? `?farmId=${farmId}` : ''}`);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-slate-400">{t('common.loading')}</div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-200">{t('field.title')}</h1>
          <p className="text-slate-400 mt-1">Manage your fields</p>
        </div>
        <button
          onClick={handleCreateField}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
        >
          + {t('field.create')}
        </button>
      </div>

      {fields.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-6xl mb-4">🗺️</div>
          <h3 className="text-xl font-medium text-slate-200 mb-2">{t('field.no_fields')}</h3>
          <p className="text-slate-400 mb-6">{t('field.create_first')}</p>
          <button
            onClick={handleCreateField}
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
          >
            {t('field.create')}
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {fields.map((field) => (
            <div
              key={field.id}
              onClick={() => handleFieldClick(field)}
              className="bg-slate-800 border border-slate-700 rounded-xl p-6 cursor-pointer hover:border-blue-500 transition-colors"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-slate-200">{field.name}</h3>
                  <p className="text-slate-400 text-sm mt-1">
                    {field.area_hectares.toFixed(2)} {t('field.hectares')}
                  </p>
                </div>
                <span
                  className={`px-2 py-1 text-xs font-medium rounded-full ${
                    field.status === 'active'
                      ? 'bg-green-500/20 text-green-400'
                      : 'bg-slate-600 text-slate-300'
                  }`}
                >
                  {field.status}
                </span>
              </div>
              <div className="mt-4 flex items-center gap-2 text-sm text-slate-400">
                <span>📍</span>
                <span>
                  {field.centroid.coordinates[1].toFixed(4)},{' '}
                  {field.centroid.coordinates[0].toFixed(4)}
                </span>
              </div>
              <div className="mt-2 text-xs text-slate-500">
                Created {new Date(field.created_at).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
