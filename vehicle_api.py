import os, json
from flask import jsonify, request, current_app

def register_vehicle_routes(app):
    """Register API endpoints for loading vehicle JSON files.
    These files are stored in `static/vehicles/` and contain the
    serialized vehicle data that can be passed to ``bakeVehicle`` or
    ``bakePlane`` on the client side.
    """
    @app.route('/api/vehicles', methods=['GET'])
    def list_vehicles():
        vehicle_dir = os.path.join(app.root_path, 'static', 'vehicles')
        if not os.path.isdir(vehicle_dir):
            return jsonify([])
        files = [f for f in os.listdir(vehicle_dir) if f.lower().endswith('.json')]
        return jsonify(files)

    @app.route('/api/vehicle/<filename>', methods=['GET'])
    def get_vehicle(filename):
        # Basic sanitisation to prevent path traversal
        if '..' in filename or '/' in filename or '\\' in filename:
            return jsonify({'error': 'Invalid filename'}), 400
        vehicle_dir = os.path.join(app.root_path, 'static', 'vehicles')
        path = os.path.join(vehicle_dir, filename)
        if not os.path.isfile(path):
            return jsonify({'error': 'File not found'}), 404
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return jsonify(data)

