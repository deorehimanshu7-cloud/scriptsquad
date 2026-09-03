import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api/client';

interface Farm {
  id: string;
  name: string;
  location?: { type: 'Point'; coordinates: [number, number] };
  created_at: string;
}

export default function FarmsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  
  const [farms, setFarms] = useState<Farm[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newFarmName, setNewFarmName] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchFarms();
  }, []);

  const fetchFarms = async () => {
    try {
      const response = await api.get<{ success: boolean; data: Farm[] }>('/farms');
      if (response.success) {
        setFarms(response.data);
      }
    } catch (error) {
      console.error('Failed to fetch farms:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateFarm = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);

    try {
      const response = await api.post<{ success: boolean; data: Farm }>('/farms', {
        name: newFarmName,
      });

      if (response.success) {
        setFarms([...farms, response.data]);
        setShowCreateModal(false);
        setNewFarmName('');
      }
    } catch (error) {
      console.error('Failed to create farm:', error);
    } finally {
      setCreating(false);
    }
  };

  const handleFarmClick = (farmId: string) => {
    navigate(`/fields?farmId=${farmId}`);
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
          <h1 className="text-2xl font-bold text-slate-200">{t('farm.title')}</h1>
          <p className="text-slate-400 mt-1">Manage your farms and fields</p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
        >
          + {t('farm.create')}
        </button>
      </div>

      {farms.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-6xl mb-4">🌾</div>
          <h3 className="text-xl font-medium text-slate-200 mb-2">{t('farm.no_farms')}</h3>
          <p className="text-slate-400 mb-6">{t('farm.create_first')}</p>
          <button
            onClick={() => setShowCreateModal(true)}
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
          >
            {t('farm.create')}
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {farms.map((farm) => (
            <div
              key={farm.id}
              onClick={() => handleFarmClick(farm.id)}
              className="bg-slate-800 border border-slate-700 rounded-xl p-6 cursor-pointer hover:border-blue-500 transition-colors"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-slate-200">{farm.name}</h3>
                  <p className="text-slate-400 text-sm mt-1">
                    Created {new Date(farm.created_at).toLocaleDateString()}
                  </p>
                </div>
                <span className="text-2xl">🏡</span>
              </div>
              <div className="mt-4 flex items-center gap-2 text-sm text-slate-400">
                <span>📍</span>
                <span>
                  {farm.location
                    ? `${farm.location.coordinates[1].toFixed(4)}, ${farm.location.coordinates[0].toFixed(4)}`
                    : 'No location set'}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Farm Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-800 rounded-xl p-6 w-full max-w-md border border-slate-700">
            <h2 className="text-xl font-semibold text-slate-200 mb-4">{t('farm.create')}</h2>
            <form onSubmit={handleCreateFarm}>
              <div className="mb-4">
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  {t('farm.name')}
                </label>
                <input
                  type="text"
                  value={newFarmName}
                  onChange={(e) => setNewFarmName(e.target.value)}
                  className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-slate-200 placeholder-slate-400 focus:outline-none focus:border-blue-500"
                  placeholder="My Farm"
                  required
                />
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 font-medium rounded-lg transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 text-white font-medium rounded-lg transition-colors"
                >
                  {creating ? t('common.loading') : t('common.create')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
