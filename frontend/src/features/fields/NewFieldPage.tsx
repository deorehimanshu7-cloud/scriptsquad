import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useFieldStore } from '@/lib/state/field';
import { api } from '@/lib/api/client';

export default function NewFieldPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const farmId = searchParams.get('farmId');
  
  const [name, setName] = useState('');
  const [coordinates, setCoordinates] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const handleCreateField = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError('');

    try {
      // Parse coordinates (format: "lat1,lng1;lat2,lng2;lat3,lng3;lat4,lng4")
      const coordPairs = coordinates.split(';').map((pair) => {
        const [lat, lng] = pair.split(',').map(Number);
        return [lng, lat]; // GeoJSON uses [lng, lat]
      });

      // Close the polygon
      if (coordPairs.length > 0) {
        coordPairs.push(coordPairs[0]);
      }

      const geometry = {
        type: 'Polygon' as const,
        coordinates: [coordPairs],
      };

      const response = await api.post<{ success: boolean; data: any }>('/fields', {
        farm_id: farmId || 'default-farm',
        name,
        geometry,
      });

      if (response.success) {
        useFieldStore.getState().addField(response.data);
        useFieldStore.getState().setCurrentField(response.data);
        navigate('/world');
      }
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to create field');
    } finally {
      setCreating(false);
    }
  };

  const handleGetCurrentLocation = () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude } = position.coords;
          // Create a small polygon around the current location
          const size = 0.001; // ~100m
          const coords = [
            `${latitude + size},${longitude + size}`,
            `${latitude + size},${longitude - size}`,
            `${latitude - size},${longitude - size}`,
            `${latitude - size},${longitude + size}`,
          ].join(';');
          setCoordinates(coords);
        },
        (err) => {
          console.error('Geolocation error:', err);
          setError('Failed to get current location');
        }
      );
    }
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-200">{t('field.create')}</h1>
        <p className="text-slate-400 mt-1">Define your field boundary</p>
      </div>

      <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
        {error && (
          <div className="mb-4 p-3 bg-red-500/20 border border-red-500 rounded-lg text-red-400 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleCreateField} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              {t('field.name')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-slate-200 placeholder-slate-400 focus:outline-none focus:border-blue-500"
              placeholder="North Field"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              {t('field.geometry')}
            </label>
            <p className="text-xs text-slate-400 mb-2">
              Enter coordinates as: lat1,lng1;lat2,lng2;lat3,lng3;lat4,lng4
            </p>
            <textarea
              value={coordinates}
              onChange={(e) => setCoordinates(e.target.value)}
              className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-slate-200 placeholder-slate-400 focus:outline-none focus:border-blue-500 font-mono text-sm"
              placeholder="12.9716,77.5946;12.9718,77.5948;12.9715,77.5950;12.9713,77.5947"
              rows={4}
              required
            />
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleGetCurrentLocation}
              className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 font-medium rounded-lg transition-colors"
            >
              📍 {t('field.use_current_location')}
            </button>
          </div>

          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={() => navigate(-1)}
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
  );
}
